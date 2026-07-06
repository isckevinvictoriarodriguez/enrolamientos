const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pLimit = require('p-limit');
const { getCisecPool, sql } = require('../db/cisec_config.js');

const WATERMARK_FILE = path.join(__dirname, 'cisec_watermark.json');
const FAILURES_FILE = path.join(__dirname, 'cisec_fallidos.log');

// CONFIGURACIÓN desde .env
const LOTE = parseInt(process.env.CISEC_LOTE) || 1000;
const CONCURRENCIA = parseInt(process.env.CISEC_CONCURRENCIA) || 5;
const REGULA_URL = process.env.REGULA_URL ? process.env.REGULA_URL + '/api/v1/faces/upload' : null;
const REGULA_GROUP_ID = process.env.CISEC_REGULA_GROUP_ID;

// =====================================
// UTILIDADES
// =====================================

function getLastWatermark() {
    if (fs.existsSync(WATERMARK_FILE)) {
        const data = fs.readFileSync(WATERMARK_FILE, 'utf8');
        try {
            const parsed = JSON.parse(data);
            return { date: parsed.last_date, id: parsed.last_id || '' };
        } catch (e) {}
    }
    return { date: '1900-01-01', id: '' };
}

function saveWatermark(dateStr, lastId) {
    // Convertir objeto Date a ISO string si aplica
    const str = dateStr instanceof Date ? dateStr.toISOString() : String(dateStr);
    fs.writeFileSync(WATERMARK_FILE, JSON.stringify({ last_date: str, last_id: lastId }), 'utf8');
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
        throw new Error("CONFIGURACIÓN DE REGULA NO ENCONTRADA (Verificar .env)");
    }

    // filename: concatenar p_curp + '_' + p_name + p_appat + p_appmat
    const filename = `${row.p_curp}_${row.p_name || ''}_${row.p_appat || ''}_${row.p_appmat || ''}`.replace(/\s+/g, '');

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
            timeout: 30000
        });
        return { success: true, data: resp.data };
    } catch (err) {
        const errorData = err.response ? err.response.data : null;
        const errorMsg = errorData ? JSON.stringify(errorData) : err.message;
        throw new Error(`Error en REGULA FACE API: ${errorMsg}`);
    }
}

// =====================================
// PROCESAMIENTO
// =====================================

/**
 * Procesa un lote de registros y actualiza su estado en la base de datos.
 */
async function procesarLote(rows, pool) {
    const limit = pLimit(CONCURRENCIA);
    const startTime = Date.now();

    const resultados = await Promise.all(
        rows.map(row =>
            limit(async () => {
                let regulaTime = 0;
                try {
                    const regulaStart = Date.now();
                    const base64 = bufferToBase64(row.p_pic);
                    const resp = await procesarImagen(base64, row);
                    regulaTime = Date.now() - regulaStart;

                    return {
                        p_id: row.p_id,
                        ok: resp.success === true,
                        regulaTime
                    };

                } catch (err) {
                    console.error(`P_ID: ${row.p_id} -> `, err.message);
                    logFailure(row.p_id, err.message);
                    return { p_id: row.p_id, ok: false, regulaTime: 0 };
                }
            })
        )
    );

    const totalProcessingTime = Date.now() - startTime;

    // Guardar el watermark (fecha e id) localmente basado en el último registro del lote
    const lastRow = rows[rows.length - 1];
    if (lastRow && lastRow.p_fecha_alta_inicio) {
        saveWatermark(lastRow.p_fecha_alta_inicio, lastRow.p_id);
    }

    const avgRegula = resultados.reduce((a, b) => a + b.regulaTime, 0) / (rows.length || 1);
    const successCount = resultados.filter(r => r.ok).length;
    const failCount = resultados.filter(r => !r.ok).length;

    console.log(`   ⏱ Lote ${rows.length} (✅ ${successCount} | ❌ ${failCount}): Regula Prom: ${avgRegula.toFixed(0)}ms | Total Proc: ${(totalProcessingTime / 1000).toFixed(1)}s`);

    return resultados;
}

/**
 * Función principal del worker para SQL Server CISEC.
 */
async function taskCisecCheck() {
    console.log(`\n--- Inicio de Proceso Enrolamiento CISEC (SQL Server) [${new Date().toLocaleString()}] ---`);

    let pool;
    try {
        pool = await getCisecPool();

        while (true) {
            const fetchStart = Date.now();

            const watermark = getLastWatermark();

            // TODO: Actualiza "NombreDeTuTabla" con la vista real de CISEC
            const result = await pool.request()
                .input('limit', sql.Int, LOTE)
                .input('lastDate', sql.NVarChar, watermark.date)
                .input('lastId', sql.NVarChar, String(watermark.id))
                .query(`
                    SELECT TOP (@limit) 
                        p_id, p_curp, p_pic, p_fecha_alta_inicio, p_name, p_appat, p_appmat
                    FROM NombreDeTuTabla 
                    WHERE p_fecha_alta_inicio > @lastDate
                       OR (p_fecha_alta_inicio = @lastDate AND p_id > @lastId)
                    ORDER BY p_fecha_alta_inicio ASC, p_id ASC
                `);

            const rows = result.recordset;
            const fetchTime = Date.now() - fetchStart;

            if (!rows || rows.length === 0) {
                console.log(`✅ No hay más registros pendientes de procesar.`);
                break;
            }

            console.log(`📦 Lote de ${rows.length} registros recuperado (SQL Fetch: ${fetchTime}ms)`);

            await procesarLote(rows, pool);
        }

        console.log("🎉 Proceso CISEC completo");

    } catch (err) {
        console.error("❌ Error general en el proceso de enrolamiento CISEC:", err);
    }
}

module.exports = { taskCisecCheck };
