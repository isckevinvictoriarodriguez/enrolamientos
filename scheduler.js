require('dotenv').config();
const path = require('path');
const { spawn } = require('child_process');
const { calcularFechaLimite } = require('./utils/horario.js');

/*
 * Programador de enrolamientos en dos carriles, cada uno con su candado (una fuente nunca corre encimada
 * consigo misma). Regula se comparte con los 4 despliegues de WSCRUD, que corren cada 5 minutos.
 *
 *  - Carril frecuente: las fuentes de ENROL_FUENTES en serie, cada ENROL_INTERVALO_MIN minutos.
 *    Solo consultan pendientes, asi que una vuelta sin trabajo es barata. Ignoran ENROL_HORA_LIMITE.
 *    Si una vuelta tarda mas que el intervalo, la siguiente arranca en cuanto termina.
 *  - Carril diario: DGA a ENROL_DGA_HORA, una vez al dia. DGA no tiene filtro de nuevos: recorre
 *    toda la API en cada corrida. Respeta ENROL_HORA_LIMITE y ENROL_MAX_HORAS_TAREA.
 *
 *   ENROL_INTERVALO_MIN    minutos entre inicios de vuelta del carril frecuente (default 10)
 *   ENROL_FUENTES          fuentes del carril frecuente, en orden (default ICV,AAP,CISEC)
 *   ENROL_MAX_MIN_TAREA    minutos maximos por fuente en el carril frecuente (default 60)
 *   ENROL_DGA_HORA         HH:MM del carril diario (default 01:00; vacio = DGA desactivado)
 *   ENROL_HORA_LIMITE      HH:MM en que DGA deja de iniciar lotes
 *   ENROL_MAX_HORAS_TAREA  horas maximas de la corrida de DGA (default 23)
 */

const SCRIPTS = {
    ICV: 'enrolamientoICV.js',
    AAP: 'enrolamientoAAP.js',
    CISEC: 'enrolamientoCISEC.js',
    DGA: 'enrolamientoDGA.js'
};
const HORA_VALIDA = /^([01]\d|2[0-3]):[0-5]\d$/;

function leerConfig(env = process.env) {
    const entero = (nombre, defecto) => {
        const v = parseInt(env[nombre], 10);
        return Number.isInteger(v) && v > 0 ? v : defecto;
    };
    const dgaHora = env.ENROL_DGA_HORA === undefined ? '01:00' : env.ENROL_DGA_HORA.trim();
    const avisos = [];
    if (dgaHora && !HORA_VALIDA.test(dgaHora)) avisos.push(`ENROL_DGA_HORA inválida (${dgaHora}), DGA queda desactivado. Formato esperado HH:MM`);

    const fuentes = [];
    (env.ENROL_FUENTES || 'ICV,AAP,CISEC').split(',').map(f => f.trim().toUpperCase()).filter(Boolean).forEach(f => {
        if (!SCRIPTS[f]) avisos.push(`ENROL_FUENTES: fuente desconocida "${f}", se omite`);
        // DGA en los dos carriles podria correr encimado consigo mismo (cursor y cache en archivos)
        else if (f === 'DGA' && HORA_VALIDA.test(dgaHora)) avisos.push('ENROL_FUENTES: DGA ya corre en el carril diario, se omite del frecuente');
        else if (!fuentes.includes(f)) fuentes.push(f);
    });

    return {
        intervaloMin: entero('ENROL_INTERVALO_MIN', 10),
        fuentes,
        maxMinTarea: entero('ENROL_MAX_MIN_TAREA', 60),
        dgaHora: HORA_VALIDA.test(dgaHora) ? dgaHora : '',
        maxHorasTarea: parseFloat(env.ENROL_MAX_HORAS_TAREA) || 23,
        avisos
    };
}

const marca = () => `[${new Date().toLocaleString()}]`;

/**
 * Ejecuta un script de enrolamiento como proceso hijo y lo detiene si excede timeoutMs.
 * @returns {Promise<{codigo: number|null, segundos: number, excedido: boolean}>}
 */
function ejecutarScript(scriptName, envExtra, timeoutMs) {
    return new Promise(resolve => {
        const inicio = Date.now();
        const env = { ...process.env, ...envExtra };
        if (!envExtra.ENROL_FECHA_LIMITE) delete env.ENROL_FECHA_LIMITE;
        let excedido = false;

        const child = spawn(process.execPath, [path.join(__dirname, scriptName)], { stdio: 'inherit', cwd: __dirname, env });
        const timeout = setTimeout(() => {
            excedido = true;
            console.error(`${marca()} Tarea ${scriptName} excedió ${Math.round(timeoutMs / 60000)} min, se detiene`);
            child.kill();
        }, timeoutMs);

        child.on('error', (err) => {
            console.error(`${marca()} No se pudo ejecutar ${scriptName}:`, err.message);
        });
        child.on('close', (codigo) => {
            clearTimeout(timeout);
            resolve({ codigo, segundos: Math.round((Date.now() - inicio) / 1000), excedido });
        });
    });
}

/**
 * Logica de los dos carriles. Recibe sus dependencias para probarla con reloj y procesos simulados.
 * @param {object} deps - { config, ejecutar?, ahora?, log? }
 * @returns {{ tick: Function, estado: object }}
 */
function crearScheduler(deps) {
    const { config } = deps;
    const ejecutar = deps.ejecutar || ejecutarScript;
    const ahora = deps.ahora || (() => new Date());
    const log = deps.log || console;
    const estado = {
        frecuente: { enEjecucion: false, ultimoInicio: null, vueltas: 0 },
        dga: { enEjecucion: false, ultimoDia: null }
    };

    async function vueltaFrecuente() {
        const f = estado.frecuente;
        f.enEjecucion = true;
        f.ultimoInicio = ahora();
        f.vueltas++;
        const resumen = [];
        try {
            for (const fuente of config.fuentes) {
                const r = await ejecutar(SCRIPTS[fuente], { ENROL_SIN_LIMITE: '1' }, config.maxMinTarea * 60000);
                resumen.push(`${fuente} (código ${r.codigo}, ${r.segundos}s${r.excedido ? ', detenida por tiempo' : ''})`);
            }
        } catch (err) {
            log.error(`${marca()} Error en la vuelta ${f.vueltas}:`, err.message);
        } finally {
            const segundos = Math.round((ahora() - f.ultimoInicio) / 1000);
            const tarde = segundos > config.intervaloMin * 60 ? ` | tardó más que el intervalo de ${config.intervaloMin} min` : '';
            log.log(`${marca()} Vuelta ${f.vueltas} terminada en ${segundos}s: ${resumen.join(' → ')}${tarde}`);
            f.enEjecucion = false;
        }
    }

    async function corridaDga(dia) {
        const d = estado.dga;
        d.enEjecucion = true;
        d.ultimoDia = dia;
        try {
            const fechaLimite = calcularFechaLimite(ahora());
            log.log(`${marca()} Ejecutando DGA (carril diario)${fechaLimite ? ' hasta ' + fechaLimite.toLocaleString() : ''}`);
            const envExtra = fechaLimite ? { ENROL_FECHA_LIMITE: fechaLimite.toISOString() } : {};
            const r = await ejecutar(SCRIPTS.DGA, envExtra, config.maxHorasTarea * 3600000);
            log.log(`${marca()} DGA terminado en ${Math.round(r.segundos / 60)} min (código ${r.codigo}${r.excedido ? ', detenido por tiempo' : ''})`);
        } catch (err) {
            log.error(`${marca()} Error en DGA:`, err.message);
        } finally {
            d.enEjecucion = false;
        }
    }

    function tick() {
        const now = ahora();
        const f = estado.frecuente;
        if (config.fuentes.length && !f.enEjecucion && (f.ultimoInicio === null || now - f.ultimoInicio >= config.intervaloMin * 60000)) {
            vueltaFrecuente();
        }

        if (config.dgaHora) {
            const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
            const dia = now.toDateString();
            if (hhmm === config.dgaHora && estado.dga.ultimoDia !== dia) {
                if (estado.dga.enEjecucion) {
                    estado.dga.ultimoDia = dia;
                    log.log(`${marca()} DGA de ayer sigue en ejecución, se omite la corrida de hoy`);
                } else {
                    corridaDga(dia);
                }
            }
        }
    }

    return { tick, estado };
}

if (require.main === module) {
    const config = leerConfig();
    console.log('Iniciando Programador (Scheduler) de Enrolamientos...');
    config.avisos.forEach(a => console.warn(a));
    console.log(`- Carril frecuente: ${config.fuentes.join(' → ') || '(sin fuentes)'} cada ${config.intervaloMin} min | máximo por fuente: ${config.maxMinTarea} min | sin hora límite`);
    console.log(`- Carril diario: ${config.dgaHora ? 'DGA a las ' + config.dgaHora + ' | hora límite: ' + (process.env.ENROL_HORA_LIMITE || 'sin límite') + ' | máximo: ' + config.maxHorasTarea + 'h' : 'DGA desactivado'}`);

    const { tick } = crearScheduler({ config });
    tick();
    // Revisar cada 30 segundos
    setInterval(tick, 30000);
}

module.exports = { leerConfig, crearScheduler, SCRIPTS };
