const oracledb = require('oracledb');
const axios = require('axios');
const pLimit = require('p-limit');
const xmlbuilder = require('xmlbuilder');
const xml2js = require('xml2js');
const { getIcvConnection } = require('../db/icv_config.js');
const { calcularFechaLimite } = require('../utils/horario.js');

// CONFIGURACIÓN desde .env
const LOTE = parseInt(process.env.ICV_LOTE);
const CONCURRENCIA = parseInt(process.env.ICV_CONCURRENCIA);
const URL_FOTO = process.env.ICV_URL_FOTO;
const REGULA_URL = process.env.REGULA_URL ? process.env.REGULA_URL + '/api/v1/faces/upload' : null;
const REGULA_ICV_GROUP_ID = process.env.REGULA_ICV_GROUP_ID;
const BIOMETRIC_API_SECRET = process.env.BIOMETRIC_API_SECRET || '';

// Modo de enrolamiento: 'anio' (por año de fecha_pago) | 'procesada' (solo procesada = 0)
const MODO = (process.env.ICV_MODO || 'anio').trim().toLowerCase();
const ANIOS = (process.env.ICV_ANIOS || '2026').split(',').map(a => parseInt(a.trim())).filter(a => !isNaN(a));

// Control de carga (0 = deshabilitado)
const MAX_REGISTROS = parseInt(process.env.ICV_MAX_REGISTROS) || 0;
const PAUSA_LOTE_MS = parseInt(process.env.ICV_PAUSA_LOTE_MS) || 0;
const MAX_ERROR_PCT = parseFloat(process.env.ICV_MAX_ERROR_PCT) || 0;
const MAX_REGULA_MS = parseInt(process.env.ICV_MAX_REGULA_MS) || 0;

// Valores del campo procesada
const ESTATUS = {
    PENDIENTE: 0,
    ENROLADO: 1,
    ERROR: 4,     // Error definitivo (sin foto, imagen inválida, sin rostro)
    REINTENTO: 5  // Error transitorio, se regresa a PENDIENTE al iniciar la siguiente ejecución
};

const CODIGOS_RED_TRANSITORIOS = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'];

// =====================================
// UTILIDADES
// =====================================
/**
 * Extrae el nombre de la imagen de una ruta completa, sin extensión.
 * Ejemplo: H:\Ruta\FOTO123.JPG -> FOTO123
 */
function extraerNombreImagen(fullPath) {
    if (!fullPath) return "imagen_sin_nombre";
    const baseName = fullPath.split(/[\\/]/).pop();
    const nameWithoutExt = baseName.split('.')[0];
    return nameWithoutExt.replace(/\s+/g, '_');
}

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

async function obtenerBase64(foto) {
    try {
        // Construir el sobre SOAP 1.2 usando xmlbuilder
        const xml = xmlbuilder.create({
            'soap:Envelope': {
                '@xmlns:soap': 'http://www.w3.org/2003/05/soap-envelope',
                '@xmlns:tem': 'http://tempuri.org/',
                'soap:Header': {},
                'soap:Body': {
                    'tem:ObtenerRecurso': {
                        'tem:UrlRecurso': foto,
                        'tem:Usuario': process.env.ICV_SOAP_USER,
                        'tem:Clave': process.env.ICV_SOAP_PASS
                    }
                }
            }
        }).end({ pretty: true });

        const resp = await axios.post(URL_FOTO, xml, {
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8'
            },
            timeout: 10000
        });

        // Mutar la respuesta XML a objeto JS
        const parser = new xml2js.Parser({ explicitArray: false, ignoreNamespaces: true });
        const result = await parser.parseStringPromise(resp.data);

        // Extraer datos (maneja estructura típica Body -> Response -> Result)
        const envelope = result.Envelope || result['soap:Envelope'];
        const body = envelope.Body || envelope['soap:Body'];
        const responseTag = Object.keys(body).find(k => k.toLowerCase().includes('response'));
        const responseData = body[responseTag];

        // Buscar el resultado (Result o directamente los campos)
        const resultKey = Object.keys(responseData).find(k => k.toLowerCase().includes('result'));
        const finalData = resultKey ? responseData[resultKey] : responseData;

        // Validar Errores según requerimiento del usuario
        // HayError tipo string 'true' o booleano true
        if (finalData.HayError === 'true' || finalData.HayError === true) {
            throw new Error(finalData.Error || 'Error desconocido en el servicio SOAP');
        }
        // console.log("finalData -> ", JSON.stringify(finalData).substring(0, 100));
        return finalData.Archivo || "";

    } catch (err) {
        console.error(`Error al obtener base64 para la foto [${foto}]:`, err.message);
        err.transitorio = esErrorTransitorio(err);
        throw err;
    }
}

async function procesarImagen(base64, row) {
    if (!base64) throw new Error("Base64 vacío, omitiendo enrolamiento en Regula.");

    if (!REGULA_URL || !REGULA_ICV_GROUP_ID) {
        const error = new Error("CONFIGURACIÓN DE REGULA NO ENCONTRADA (Verificar .env)");
        error.transitorio = true;
        throw error;
    }

    const filename = extraerNombreImagen(row.FOTO);

    const payload = {
        image_base64: base64,
        filename: filename,
        group_ids: [REGULA_ICV_GROUP_ID],
        metadata: {
            curp: row.CURP,
            licencia: row.LICENCIA
        }
    };

    // console.log("payload -> ", JSON.stringify(payload).substring(0, 600));

    try {
        const resp = await axios.post(REGULA_URL, payload, {
            headers: {
                "x-api-secret": BIOMETRIC_API_SECRET
            },
            timeout: 30000 // 30 segundos solicitados
        });
        // console.log("resp data -> ", JSON.stringify(resp.data).substring(0, 500));

        return { success: true, data: resp.data };
    } catch (err) {
        const errorData = err.response ? err.response.data : null;
        const errorMsg = errorData ? JSON.stringify(errorData) : err.message;
        const error = new Error(`Error en REGULA FACE API: ${errorMsg}`);
        error.transitorio = esErrorTransitorio(err);
        throw error;
    }
}

// =====================================
// PROCESAMIENTO
// =====================================

async function procesarLote(rows, connection) {
    const limit = pLimit(CONCURRENCIA);
    const startTime = Date.now();

    const resultados = await Promise.all(
        rows.map(row =>
            limit(async () => {
                let soapTime = 0;
                let regulaTime = 0;
                let regulaStart = 0;
                try {
                    const soapStart = Date.now();
                    const base64 = await obtenerBase64(row.FOTO);
                    soapTime = Date.now() - soapStart;

                    regulaStart = Date.now();
                    const resp = await procesarImagen(base64, row);
                    regulaTime = Date.now() - regulaStart;

                    return {
                        licencia: row.LICENCIA,
                        estatus: resp.success === true ? ESTATUS.ENROLADO : ESTATUS.ERROR,
                        soapTime,
                        regulaTime
                    };

                } catch (err) {
                    if (regulaStart) regulaTime = Date.now() - regulaStart;
                    const estatus = err.transitorio ? ESTATUS.REINTENTO : ESTATUS.ERROR;
                    console.error(`LICENCIA ICV: ${row.LICENCIA} [${err.transitorio ? 'reintento' : 'error'}] -> `, err.message);
                    return { licencia: row.LICENCIA, estatus, soapTime, regulaTime };
                }
            })
        )
    );

    const totalProcessingTime = Date.now() - startTime;

    // Agrupar licencias por estatus resultante: 1 = enrolado, 4 = error, 5 = reintento
    const porEstatus = {};
    for (const r of resultados) {
        (porEstatus[r.estatus] = porEstatus[r.estatus] || []).push({ licencia: r.licencia });
    }

    const updateStart = Date.now();

    for (const [estatus, licencias] of Object.entries(porEstatus)) {
        await connection.executeMany(
            `UPDATE licencias_icv SET procesada = ${parseInt(estatus)} WHERE licencia = :licencia`,
            licencias
        );
    }

    if (resultados.length > 0) {
        await connection.commit();
    }
    const updateTime = Date.now() - updateStart;

    const conteo = estatus => (porEstatus[estatus] || []).length;
    const conRegula = resultados.filter(r => r.regulaTime > 0);
    const avgSoap = resultados.reduce((a, b) => a + b.soapTime, 0) / rows.length;
    const avgRegula = conRegula.length ? conRegula.reduce((a, b) => a + b.regulaTime, 0) / conRegula.length : 0;

    console.log(`   ⏱ Lote ${rows.length}: OK ${conteo(ESTATUS.ENROLADO)} | Error ${conteo(ESTATUS.ERROR)} | Reintento ${conteo(ESTATUS.REINTENTO)} | SOAP Prom: ${avgSoap.toFixed(0)}ms | Regula Prom: ${avgRegula.toFixed(0)}ms | Proc: ${(totalProcessingTime / 1000).toFixed(1)}s | DB Update: ${(updateTime / 1000).toFixed(1)}s`);

    return { total: rows.length, reintentos: conteo(ESTATUS.REINTENTO), avgRegula };
}

// =====================================
// CONTROL DE CARGA
// =====================================

function marcarDetencion(control, motivo) {
    if (control.detener) return;
    control.detener = true;
    control.motivo = motivo;
    console.log(`⛔ Deteniendo enrolamiento ICV: ${motivo}`);
}

function debeDetener(control) {
    if (control.detener) return true;

    if (MAX_REGISTROS > 0 && control.asignados >= MAX_REGISTROS) {
        marcarDetencion(control, `tope de ${MAX_REGISTROS} registros por ejecución alcanzado`);
    } else if (control.fechaLimite && new Date() >= control.fechaLimite) {
        marcarDetencion(control, `hora límite alcanzada (${control.fechaLimite.toLocaleString()})`);
    }
    return control.detener;
}

// Reserva el cupo del siguiente lote antes de consultar, para respetar el tope con varios workers en paralelo
function reservarCupo(control) {
    if (MAX_REGISTROS <= 0) return LOTE;
    const cupo = Math.min(LOTE, MAX_REGISTROS - control.asignados);
    control.asignados += cupo;
    return cupo;
}

function liberarCupo(control, sobrante) {
    if (MAX_REGISTROS > 0) control.asignados -= sobrante;
}

// Circuit breaker: si Regula/SOAP muestran saturación, se detiene para no competir con otro enrolamiento
function evaluarSaturacion(resumen, control, nombre) {
    const pctReintentos = resumen.reintentos * 100 / resumen.total;

    if (MAX_ERROR_PCT > 0 && pctReintentos >= MAX_ERROR_PCT) {
        marcarDetencion(control, `circuit breaker: ${pctReintentos.toFixed(0)}% de errores transitorios en lote (${nombre})`);
    } else if (MAX_REGULA_MS > 0 && resumen.avgRegula > MAX_REGULA_MS) {
        marcarDetencion(control, `circuit breaker: Regula promedió ${resumen.avgRegula.toFixed(0)}ms en lote (${nombre}), límite ${MAX_REGULA_MS}ms`);
    }
}

// =====================================
// WORKERS
// =====================================

const SQL_POR_ANIO = `
    SELECT *
    FROM (
        SELECT *
        FROM licencias_icv
        WHERE procesada = 0
        AND fecha_pago >= TO_DATE(:anio || '-01-01', 'YYYY-MM-DD')
        AND fecha_pago < TO_DATE((:anio + 1) || '-01-01', 'YYYY-MM-DD')
        ORDER BY fecha_pago DESC, licencia DESC
    )
    WHERE ROWNUM <= :limite
`;

const SQL_POR_PROCESADA = `
    SELECT *
    FROM (
        SELECT *
        FROM licencias_icv
        WHERE procesada = 0
        ORDER BY fecha_pago DESC NULLS LAST, licencia DESC
    )
    WHERE ROWNUM <= :limite
`;

async function ejecutarWorker(nombre, consulta, binds, control) {
    let connection;

    console.log(`🚀 Worker iniciado: ${nombre}`);

    try {
        connection = await getIcvConnection();

        while (!debeDetener(control)) {
            const limite = reservarCupo(control);

            const fetchStart = Date.now();
            const result = await connection.execute(
                consulta,
                { ...binds, limite },
                { outFormat: oracledb.OUT_FORMAT_OBJECT }
            );

            const rows = result.rows;
            const fetchTime = Date.now() - fetchStart;
            liberarCupo(control, limite - rows.length);

            if (rows.length === 0) {
                console.log(`✅ ${nombre} terminado`);
                break;
            }

            console.log(`📦 ${nombre} → lote ${rows.length} (Oracle Fetch: ${fetchTime}ms)`);

            const resumen = await procesarLote(rows, connection);
            control.procesados += rows.length;
            evaluarSaturacion(resumen, control, nombre);

            if (PAUSA_LOTE_MS > 0 && !debeDetener(control)) {
                await esperar(PAUSA_LOTE_MS);
            }
        }

    } catch (err) {
        console.error(`❌ Error en worker ${nombre}:`, err);
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error('Error al cerrar conexión Oracle -> ', err.message);
            }
        }
    }
}

/**
 * Regresa a pendiente los registros con error transitorio de ejecuciones anteriores
 * y reporta cuántos registros hay por procesar.
 */
async function prepararEjecucion() {
    let connection;
    try {
        connection = await getIcvConnection();

        const reactivados = await connection.execute(
            `UPDATE licencias_icv SET procesada = ${ESTATUS.PENDIENTE} WHERE procesada = ${ESTATUS.REINTENTO}`
        );
        await connection.commit();

        const pendientes = await connection.execute(
            `
            SELECT COUNT(*) AS TOTAL,
                   NVL(SUM(CASE WHEN fecha_pago IS NULL THEN 1 ELSE 0 END), 0) AS SIN_FECHA
            FROM licencias_icv
            WHERE procesada = ${ESTATUS.PENDIENTE}
            `,
            {},
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const { TOTAL, SIN_FECHA } = pendientes.rows[0];

        console.log(`🔁 Reintentos reactivados: ${reactivados.rowsAffected} | 📋 Pendientes: ${TOTAL} (sin fecha_pago: ${SIN_FECHA})`);
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error('Error al cerrar conexión Oracle -> ', err.message);
            }
        }
    }
}

// =====================================
// MAIN / CRON JOB ENTRY
// =====================================

async function taskOracleCheck() {
    console.log(`\n--- Inicio de Proceso Enrolamiento ICV [${new Date().toLocaleString()}] ---`);

    if (!['anio', 'procesada'].includes(MODO)) {
        console.error(`ICV_MODO inválido (${MODO}). Valores permitidos: anio | procesada`);
        return;
    }

    const control = {
        asignados: 0,
        procesados: 0,
        detener: false,
        motivo: null,
        fechaLimite: calcularFechaLimite()
    };

    console.log(`Modo: ${MODO}${MODO === 'anio' ? ` [${ANIOS.join(', ')}]` : ''} | Tope: ${MAX_REGISTROS || 'sin tope'} | Hora límite: ${control.fechaLimite ? control.fechaLimite.toLocaleString() : 'sin límite'}`);

    try {
        await prepararEjecucion();

        if (MODO === 'procesada') {
            // Un solo worker: varios workers sobre la misma consulta tomarían los mismos registros
            await ejecutarWorker('procesada = 0', SQL_POR_PROCESADA, {}, control);
        } else {
            await Promise.all(
                ANIOS.map(anio => ejecutarWorker(`Año ${anio}`, SQL_POR_ANIO, { anio }, control))
            );
        }

        console.log(`🎉 Proceso completo. Registros procesados: ${control.procesados}${control.motivo ? ` | Detenido por: ${control.motivo}` : ''}`);

    } catch (err) {
        console.error("Error general en el proceso de enrolamiento:", err);
    }
}

module.exports = { taskOracleCheck };
