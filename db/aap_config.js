require('dotenv').config();
const sql = require('mssql');

const aapConfig = {
    user: process.env.AAP_DB_USER,
    password: process.env.AAP_DB_PASSWORD,
    server: process.env.AAP_DB_SERVER,
    database: process.env.AAP_DB_DATABASE,
    port: parseInt(process.env.AAP_DB_PORT) || 1433,
    options: {
        encrypt: false, // Cambiar a true si usas Azure o TLS
        trustServerCertificate: true, // Útil para entornos locales/desarrollo
    },
    pool: {
        max: 50,
        min: 2,
        idleTimeoutMillis: 30000
    }
};

let poolPromise;

/**
 * Inicializa y devuelve el pool de conexiones.
 * Mantiene una única instancia del pool (Singleton).
 */
async function getAapPool() {
    if (!poolPromise) {
        poolPromise = new sql.ConnectionPool(aapConfig)
            .connect()
            .then(pool => {
                console.log('✅ Pool de conexiones SQL Server (AAP) iniciado correctamente.');
                return pool;
            })
            .catch(err => {
                poolPromise = null;
                console.error('❌ Error al crear el pool de SQL Server:', err.message);
                throw err;
            });
    }
    return poolPromise;
}

/**
 * Cierra el pool de conexiones.
 */
async function closeAapPool() {
    if (poolPromise) {
        const pool = await poolPromise;
        await pool.close();
        poolPromise = null;
        console.log('🛑 Pool de SQL Server (AAP) cerrado.');
    }
}

// Escuchar eventos de terminación para cerrar el pool
process.on('SIGINT', async () => {
    await closeAapPool();
    process.exit(0);
});

// Prueba de conexión si se ejecuta directamente
if (require.main === module) {
    (async () => {
        try {
            const pool = await getAapPool();
            const result = await pool.request().query('SELECT GETDATE() as test_date');
            console.log('Prueba de conexión exitosa. Hora del servidor:', result.recordset[0].test_date);
            await closeAapPool();
        } catch (err) {
            console.error('Error en prueba de conexión:', err.message);
        }
    })();
}

module.exports = {
    getAapPool,
    closeAapPool,
    sql // Exportamos el objeto sql para usar tipos de datos o constantes si es necesario
};
