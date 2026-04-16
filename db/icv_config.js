require('dotenv').config();
const oracledb = require('oracledb');

// Configuración de Thick Mode (necesario para versiones antiguas de Oracle)
try {
    // En Windows se usa la ruta proporcionada por el usuario
    // En Linux se dejará vacío si está en el LD_LIBRARY_PATH o se usará variable de entorno
    const libDir = process.platform === 'win32'
        ? 'C:\\instantclient-basiclite-windows.x64-23.26.1.0.0\\instantclient_23_0'
        : process.env.ORACLE_LIB_DIR;

    oracledb.initOracleClient({ libDir });
    console.log('Oracle Client (Thick Mode) inicializado.');
} catch (err) {
    console.error('Error al inicializar Oracle Client:', err.message);
}

// Configuración de la base de datos ICV desde variables de entorno
const icvConfig = {
    user: process.env.ICV_DB_USER,
    password: process.env.ICV_DB_PASSWORD,
    connectString: process.env.ICV_DB_CONNECT_STRING,
};

// Configuración del pool de conexiones
const poolConfig = {
    ...icvConfig,
    poolMin: parseInt(process.env.ICV_DB_POOL_MIN) || 2,
    poolMax: parseInt(process.env.ICV_DB_POOL_MAX) || 10,
    poolIncrement: parseInt(process.env.ICV_DB_POOL_INCREMENT) || 1,
    poolAlias: 'icvPool',
};

// Inicializa el pool de conexiones (llamar una sola vez al iniciar la app)
async function initIcvPool() {
    try {
        await oracledb.createPool(poolConfig);
        console.log('Pool de conexiones ICV (Oracle) iniciado correctamente.');
    } catch (err) {
        console.error('Error al crear el pool ICV -> ', err ? JSON.stringify(err).substring(0, 70) : '');
        throw err;
    }
}

// Obtiene una conexión del pool
async function getIcvConnection() {
    return await oracledb.getConnection('icvPool');
}

// Cierra el pool al terminar la aplicación
async function closeIcvPool() {
    try {
        await oracledb.getPool('icvPool').close(10);
        console.log('Pool ICV cerrado correctamente.');
    } catch (err) {
        console.error('Error al cerrar el pool ICV:', err);
    }
}

// ─── SCRIPT DE PRUEBA (solo cuando se ejecuta directamente) ──────────────────
// Uso: node db/icv_config.js
if (require.main === module) {
    (async () => {
        let connection;
        try {
            // Conexión directa (sin pool) para prueba rápida
            connection = await oracledb.getConnection(icvConfig);
            console.log('Conexión exitosa a ICV - Oracle!');
            console.log(`   Servidor : ${process.env.ICV_DB_CONNECT_STRING}`);
            console.log(`   Usuario  : ${process.env.ICV_DB_USER}`);

            // Consulta de prueba
            const result = await connection.execute(
                `SELECT * FROM licencias_icv WHERE CURP = :curp`,
                { curp: 'LIAF790701HNLRHR05' },
                { outFormat: oracledb.OUT_FORMAT_OBJECT }
            );

            console.log('\nResultados:');
            if (result.rows.length === 0) {
                console.log('   Sin registros encontrados.');
            } else {
                console.table(result.rows);
            }

        } catch (err) {
            console.error('Error al conectar o ejecutar la consulta:', err.message);
        } finally {
            if (connection) {
                await connection.close();
                console.log(' Conexión cerrada.');
            }
        }
    })();
}

module.exports = { initIcvPool, getIcvConnection, closeIcvPool };