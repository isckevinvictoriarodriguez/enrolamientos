const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pLimit = require('p-limit');
const { getCisecPool, sql } = require('../db/cisec_config.js');
const { crearControlCarga, esErrorTransitorio, esperar } = require('../utils/controlCarga.js');
const { leerJson, guardarJson } = require('../utils/archivos.js');

const WATERMARK_FILE = path.join(__dirname, 'cisec_watermark.json');
const FAILURES_FILE = path.join(__dirname, 'cisec_fallidos.log');
const RETRY_FILE = path.join(__dirname, 'cisec_reintentos.json');

// CONFIGURACIÓN desde .env
// SQL Server admite máximo 2100 parámetros, el lote de reintentos (WHERE p_id IN) se limita a 1000
const LOTE = Math.min(parseInt(process.env.CISEC_LOTE) || 1000, 1000);
const CONCURRENCIA = parseInt(process.env.CISEC_CONCURRENCIA) || 5;
const REGULA_URL = process.env.REGULA_URL ? process.env.REGULA_URL + '/api/v1/faces/upload' : null;
const REGULA_GROUP_ID = process.env.CISEC_REGULA_GROUP_ID;
const BIOMETRIC_API_SECRET = process.env.BIOMETRIC_API_SECRET || '';

// Control de carga (0 = deshabilitado)
const MAX_REGISTROS = parseInt(process.env.CISEC_MAX_REGISTROS) || 0;
const PAUSA_LOTE_MS = parseInt(process.env.CISEC_PAUSA_LOTE_MS) || 0;
const MAX_ERROR_PCT = parseFloat(process.env.CISEC_MAX_ERROR_PCT) || 0;
const MAX_REGULA_MS = parseInt(process.env.CISEC_MAX_REGULA_MS) || 0;

// Reinicia el cursor a p_id 0 para reenviar todo (los duplicados los descarta el backend por hash)
const REINICIAR = process.argv.includes('--reiniciar');

const ESTADO = { ENROLADO: 'enrolado', DUPLICADO: 'duplicado', ERROR: 'error', REINTENTO: 'reintento' };

const COLUMNAS = 'p_id, p_curp, p_pic, p_fecha_ingreso, p_name, p_appat, p_appmat';

// =====================================
// UTILIDADES
// =====================================

/**
 * El cursor avanza por p_id (entero autoincremental). El formato anterior guardaba
 * fecha + id ordenados por fecha, por lo que su id no sirve como cursor y se reinicia a 0.
 */
function getLastWatermark() {
    const parsed = leerJson(WATERMARK_FILE, {});
    if (parsed.last_date !== undefined) {
        console.log(`Watermark anterior por fecha (${parsed.last_date} / ${parsed.last_id}), se reinicia el cursor por p_id desde 0`);
        return 0;
    }
    return parseInt(parsed.last_id) || 0;
}

function saveWatermark(lastId) {
    guardarJson(WATERMARK_FILE, { last_id: lastId, actualizado: new Date().toISOString() });
}

function cargarReintentos() {
    const ids = leerJson(RETRY_FILE, []);
    return Array.isArray(ids) ? ids.map(id => parseInt(id)).filter(id => !isNaN(id)) : [];
}

function guardarReintentos(ids) {
    guardarJson(RETRY_FILE, [...new Set(ids)]);
}

function logFailure(p_id, errorMsg) {
    const logLine = `[${new Date().toISOString()}] P_ID: ${p_id} - Error: ${errorMsg}\n`;
    fs.appendFileSync(FAILURES_FILE, logLine, 'utf8');
}

/**
 * Convierte un Buffer a una cadena Base64.
 * @param {Buffer} buffer
 * @returns {string}
 */
function bufferToBase64(buffer) {
    if (!buffer) return "";
    return buffer.toString('base64');
}

/**
 * Procesa el enrolamiento en la API de Regula.
 * @param {string} base64
 * @param {object} row
 */
async function procesarImagen(base64, row) {
    if (!base64) throw new Error("Buffer de imagen vacío, omitiendo enrolamiento.");

    if (!REGULA_URL || !REGULA_GROUP_ID) {
        const error = new Error("CONFIGURACIÓN DE REGULA NO ENCONTRADA (Verificar .env)");
        error.transitorio = true;
        throw error;
    }

    // filename: concatenar p_curp + '_' + p_name + p_appat + p_appmat
    const filename = `${row.p_id}_${row.p_curp}`;

    const payload = {
        image_base64: base64, // conversion de p_pic
        filename: filename,
        group_ids: [REGULA_GROUP_ID],
        metadata: {
            p_id: row.p_id,
            p_curp: row.p_curp
        }
    };

    try {
        const resp = await axios.post(REGULA_URL, payload, {
            headers: {
                "x-api-secret": BIOMETRIC_API_SECRET
            },
            timeout: 30000
        });
        // El backend intermedio responde SUCCESS con "Duplicado por hash" cuando la imagen ya estaba enrolada
        const duplicado = /duplicado/i.test(String(resp.data && resp.data.message || ''));
        return { success: true, duplicado, data: resp.data };
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

/**
 * Procesa un lote de registros. Los errores definitivos se registran en cisec_fallidos.log
 * y los transitorios se regresan en idsReintento para la siguiente ejecución.
 */
async function procesarLote(rows) {
    const limit = pLimit(CONCURRENCIA);
    const startTime = Date.now();

    const resultados = await Promise.all(
        rows.map(row =>
            limit(async () => {
                const regulaStart = Date.now();
                try {
                    const base64 = bufferToBase64(row.p_pic);
                    const resp = await procesarImagen(base64, row);

                    return {
                        p_id: row.p_id,
                        estado: resp.duplicado ? ESTADO.DUPLICADO : ESTADO.ENROLADO,
                        regulaTime: Date.now() - regulaStart
                    };

                } catch (err) {
                    console.error(`P_ID: ${row.p_id} [${err.transitorio ? 'reintento' : 'error'}] -> `, err.message);
                    if (!err.transitorio) logFailure(row.p_id, err.message);
                    return {
                        p_id: row.p_id,
                        estado: err.transitorio ? ESTADO.REINTENTO : ESTADO.ERROR,
                        regulaTime: Date.now() - regulaStart
                    };
                }
            })
        )
    );

    const totalProcessingTime = Date.now() - startTime;

    const conteo = estado => resultados.filter(r => r.estado === estado).length;
    const idsReintento = resultados.filter(r => r.estado === ESTADO.REINTENTO).map(r => r.p_id);
    const avgRegula = resultados.reduce((a, b) => a + b.regulaTime, 0) / (rows.length || 1);

    console.log(`   ⏱ Lote ${rows.length} (✅ ${conteo(ESTADO.ENROLADO)} | ♻ duplicados ${conteo(ESTADO.DUPLICADO)} | ❌ ${conteo(ESTADO.ERROR)} | 🔁 reintento ${idsReintento.length}): Regula Prom: ${avgRegula.toFixed(0)}ms | Total Proc: ${(totalProcessingTime / 1000).toFixed(1)}s`);

    return { total: rows.length, reintentos: idsReintento.length, avgRegula, idsReintento };
}

/**
 * Función principal del worker para SQL Server CISEC.
 */
async function taskCisecCheck() {
    console.log(`\n--- Inicio de Proceso Enrolamiento CISEC (SQL Server) [${new Date().toLocaleString()}] ---`);

    const control = crearControlCarga({
        sistema: 'CISEC',
        lote: LOTE,
        maxRegistros: MAX_REGISTROS,
        maxErrorPct: MAX_ERROR_PCT,
        maxRegulaMs: MAX_REGULA_MS
    });

    let pool;
    try {
        pool = await getCisecPool();

        if (REINICIAR) {
            console.log('🔄 --reiniciar: el cursor vuelve a p_id 0, se reenviará todo');
            saveWatermark(0);
        }

        let lastId = getLastWatermark();
        let porReintentar = cargarReintentos();
        const nuevosReintentos = [];

        const pendientes = await pool.request()
            .input('lastId', sql.Int, lastId)
            .query(`SELECT COUNT(*) AS total, SUM(CASE WHEN p_id > @lastId THEN 1 ELSE 0 END) AS pendientes FROM CECC_FC`);
        const { total, pendientes: porProcesar } = pendientes.recordset[0];

        console.log(`${control.descripcion()} | Cursor: p_id > ${lastId}`);
        console.log(`📋 Registros en vista: ${total} | Pendientes desde cursor: ${porProcesar || 0} | Reintentos pendientes: ${porReintentar.length}`);

        // 1. Reintentos de ejecuciones anteriores (errores transitorios)
        while (porReintentar.length > 0 && !control.debeDetener()) {
            const cupo = control.reservarCupo();
            const ids = porReintentar.slice(0, cupo);
            porReintentar = porReintentar.slice(ids.length);

            const request = pool.request();
            ids.forEach((id, i) => request.input(`id${i}`, sql.Int, id));
            const result = await request.query(`
                SELECT ${COLUMNAS}
                FROM CECC_FC
                WHERE p_id IN (${ids.map((_, i) => `@id${i}`).join(', ')})
            `);
            const rows = result.recordset;
            control.liberarCupo(cupo - rows.length);

            console.log(`🔁 Reintentando ${rows.length} registros`);

            if (rows.length > 0) {
                const resumen = await procesarLote(rows);
                nuevosReintentos.push(...resumen.idsReintento);
                control.registrarLote(resumen, 'reintentos');
            }
            guardarReintentos([...porReintentar, ...nuevosReintentos]);

            if (PAUSA_LOTE_MS > 0 && !control.debeDetener()) await esperar(PAUSA_LOTE_MS);
        }

        // 2. Registros nuevos a partir del cursor
        while (!control.debeDetener()) {
            const fetchStart = Date.now();
            const limite = control.reservarCupo();

            const result = await pool.request()
                .input('limit', sql.Int, limite)
                .input('lastId', sql.Int, lastId)
                .query(`
                    SELECT TOP (@limit) ${COLUMNAS}
                    FROM CECC_FC
                    WHERE p_id > @lastId
                    ORDER BY p_id ASC
                `);

            const rows = result.recordset;
            const fetchTime = Date.now() - fetchStart;
            control.liberarCupo(limite - rows.length);

            if (!rows || rows.length === 0) {
                console.log(`✅ No hay más registros pendientes de procesar.`);
                break;
            }

            console.log(`📦 Lote de ${rows.length} registros recuperado, p_id ${rows[0].p_id} - ${rows[rows.length - 1].p_id} (SQL Fetch: ${fetchTime}ms)`);

            const resumen = await procesarLote(rows);
            nuevosReintentos.push(...resumen.idsReintento);
            guardarReintentos([...porReintentar, ...nuevosReintentos]);

            // Los transitorios ya quedaron en el archivo de reintentos, el cursor puede avanzar
            lastId = rows[rows.length - 1].p_id;
            saveWatermark(lastId);

            control.registrarLote(resumen, `p_id ≤ ${lastId}`);

            if (PAUSA_LOTE_MS > 0 && !control.debeDetener()) await esperar(PAUSA_LOTE_MS);
        }

        console.log(`🎉 Proceso CISEC completo. ${control.resumenFinal()} | Reintentos pendientes: ${porReintentar.length + new Set(nuevosReintentos).size}`);

    } catch (err) {
        console.error("❌ Error general en el proceso de enrolamiento CISEC:", err);
    }
}

module.exports = { taskCisecCheck };
