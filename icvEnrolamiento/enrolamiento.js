const oracledb = require('oracledb');
const axios = require('axios');
const pLimit = require('p-limit');
const xmlbuilder = require('xmlbuilder');
const xml2js = require('xml2js');
const { getIcvConnection } = require('../db/icv_config.js');

// CONFIGURACIÓN desde .env
const LOTE = parseInt(process.env.ICV_LOTE);
const CONCURRENCIA = parseInt(process.env.ICV_CONCURRENCIA);
const URL_FOTO = process.env.ICV_URL_FOTO;
const REGULA_URL = process.env.REGULA_URL ? process.env.REGULA_URL + '/api/v1/faces/upload' : null;
const REGULA_ICV_GROUP_ID = process.env.REGULA_ICV_GROUP_ID;

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
        throw err;
    }
}

async function procesarImagen(base64, row) {
    if (!base64) throw new Error("Base64 vacío, omitiendo enrolamiento en Regula.");

    if (!REGULA_URL || !REGULA_ICV_GROUP_ID) {
        throw new Error("CONFIGURACIÓN DE REGULA NO ENCONTRADA (Verificar .env)");
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
            timeout: 30000 // 30 segundos solicitados
        });
        // console.log("resp data -> ", JSON.stringify(resp.data).substring(0, 500));

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

async function procesarLote(rows, connection) {
    const limit = pLimit(CONCURRENCIA);
    const startTime = Date.now();

    const resultados = await Promise.all(
        rows.map(row =>
            limit(async () => {
                const rowStart = Date.now();
                let soapTime = 0;
                let regulaTime = 0;
                try {
                    const soapStart = Date.now();
                    const base64 = await obtenerBase64(row.FOTO);
                    soapTime = Date.now() - soapStart;

                    const regulaStart = Date.now();
                    const resp = await procesarImagen(base64, row);
                    regulaTime = Date.now() - regulaStart;

                    return {
                        licencia: row.LICENCIA,
                        ok: resp.success === true,
                        soapTime,
                        regulaTime
                    };

                } catch (err) {
                    console.error(`LICENCIA ICV: ${row.LICENCIA} -> `, err.message);
                    return { licencia: row.LICENCIA, ok: false, soapTime, regulaTime };
                }
            })
        )
    );

    const totalProcessingTime = Date.now() - startTime;

    // Separar éxitos de errores
    const exitosos = resultados.filter(r => r.ok).map(r => ({ licencia: r.licencia }));
    const fallidos = resultados.filter(r => !r.ok).map(r => ({ licencia: r.licencia }));

    let updateTime = 0;
    const updateStart = Date.now();

    // 1. Actualizar Exitosos (Status 1)
    if (exitosos.length > 0) {
        const updateResult = await connection.executeMany(
            `UPDATE licencias_icv SET procesada = 1 WHERE licencia = :licencia`,
            exitosos
        );
    }

    // 2. Actualizar Fallidos (Status 4)
    if (fallidos.length > 0) {
        await connection.executeMany(
            `UPDATE licencias_icv SET procesada = 4 WHERE licencia = :licencia`,
            fallidos
        );
    }

    if (exitosos.length > 0 || fallidos.length > 0) {
        await connection.commit();
    }
    updateTime = Date.now() - updateStart;

    const avgSoap = resultados.reduce((a, b) => a + b.soapTime, 0) / rows.length;
    const avgRegula = resultados.reduce((a, b) => a + b.regulaTime, 0) / rows.length;

    console.log(`   ⏱ Lote ${rows.length}: SOAP Prom: ${avgSoap.toFixed(0)}ms | Regula Prom: ${avgRegula.toFixed(0)}ms | Proc: ${(totalProcessingTime / 1000).toFixed(1)}s | DB Update: ${(updateTime / 1000).toFixed(1)}s`);

    return resultados;
}

// =====================================
// WORKER POR AÑO
// =====================================

async function workerPorAnio(anio) {
    let connection;

    console.log(`🚀 Worker iniciado para año ${anio}`);

    try {
        connection = await getIcvConnection();

        while (true) {
            const fetchStart = Date.now();
            const result = await connection.execute(
                `
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
                `,
                { anio: parseInt(anio), limite: LOTE },
                { outFormat: oracledb.OUT_FORMAT_OBJECT }
            );

            const rows = result.rows;
            const fetchTime = Date.now() - fetchStart;

            if (rows.length === 0) {
                console.log(`✅ Año ${anio} terminado`);
                break;
            }

            console.log(`📦 Año ${anio} → lote ${rows.length} (Oracle Fetch: ${fetchTime}ms)`);

            // Procesar lote y actualizar DB (ahora todo dentro de procesarLote para métrica unificada)
            await procesarLote(rows, connection);
        }

    } catch (err) {
        console.error(`❌ Error en worker ${anio}:`, err);
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

    try {
        // Ajusta los años según tus datos
        const anios = [2026];

        await Promise.all(
            anios.map(anio => workerPorAnio(anio))
        );

        console.log("🎉 Proceso completo");

    } catch (err) {
        console.error("Error general en el proceso de enrolamiento:", err);
    }
}

module.exports = { taskOracleCheck };
