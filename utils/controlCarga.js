const { calcularFechaLimite } = require('./horario.js');

const CODIGOS_RED_TRANSITORIOS = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'];

/**
 * Un error es transitorio cuando no depende del registro: timeout, red, saturación (5xx/429)
 * o credenciales (401/403). Estos registros se reintentan en lugar de marcarse como error.
 */
function esErrorTransitorio(err) {
    if (err.response) {
        const status = err.response.status;
        return status >= 500 || [401, 403, 408, 429].includes(status);
    }
    return !!err.request || CODIGOS_RED_TRANSITORIOS.includes(err.code);
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Control de carga por ejecución: tope de registros, hora límite y circuit breaker.
 * Los límites en 0 quedan deshabilitados.
 */
function crearControlCarga({ sistema, lote, maxRegistros = 0, maxErrorPct = 0, maxRegulaMs = 0 }) {
    const control = {
        asignados: 0,
        procesados: 0,
        detenido: false,
        motivo: null,
        fechaLimite: calcularFechaLimite()
    };

    control.detener = (motivo) => {
        if (control.detenido) return;
        control.detenido = true;
        control.motivo = motivo;
        console.log(`⛔ Deteniendo enrolamiento ${sistema}: ${motivo}`);
    };

    control.debeDetener = () => {
        if (control.detenido) return true;

        if (maxRegistros > 0 && control.asignados >= maxRegistros) {
            control.detener(`tope de ${maxRegistros} registros por ejecución alcanzado`);
        } else if (control.fechaLimite && new Date() >= control.fechaLimite) {
            control.detener(`hora límite alcanzada (${control.fechaLimite.toLocaleString()})`);
        }
        return control.detenido;
    };

    // Reserva el cupo del siguiente lote antes de consultar, para respetar el tope con varios workers en paralelo
    control.reservarCupo = () => {
        if (maxRegistros <= 0) return lote;
        const cupo = Math.min(lote, maxRegistros - control.asignados);
        control.asignados += cupo;
        return cupo;
    };

    control.liberarCupo = (sobrante) => {
        if (maxRegistros > 0) control.asignados -= sobrante;
    };

    // Circuit breaker: si Regula muestra saturación, se detiene para no competir con otro enrolamiento
    control.registrarLote = ({ total, reintentos, avgRegula }, nombre) => {
        control.procesados += total;
        const pctReintentos = total ? reintentos * 100 / total : 0;

        if (maxErrorPct > 0 && pctReintentos >= maxErrorPct) {
            control.detener(`circuit breaker: ${pctReintentos.toFixed(0)}% de errores transitorios en lote (${nombre})`);
        } else if (maxRegulaMs > 0 && avgRegula > maxRegulaMs) {
            control.detener(`circuit breaker: Regula promedió ${avgRegula.toFixed(0)}ms en lote (${nombre}), límite ${maxRegulaMs}ms`);
        }
    };

    control.descripcion = () =>
        `Tope: ${maxRegistros || 'sin tope'} | Hora límite: ${control.fechaLimite ? control.fechaLimite.toLocaleString() : 'sin límite'}`;

    control.resumenFinal = () =>
        `Registros procesados: ${control.procesados}${control.motivo ? ` | Detenido por: ${control.motivo}` : ''}`;

    return control;
}

module.exports = { crearControlCarga, esErrorTransitorio, esperar };
