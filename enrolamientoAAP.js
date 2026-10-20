const { getAapPool, closeAapPool } = require('./db/aap_config.js');
const { taskAapCheck } = require('./aapEnrolamientos/enrolamiento.js');

// Inicializar Pool de SQL Server
// Se cierra el pool y el proceso al terminar para que el scheduler pueda continuar con la cola
getAapPool().then(async () => {
    await taskAapCheck();
    await closeAapPool();
    process.exit(0);
}).catch(err => {
    console.error('Error servicio SQL Server AAP no disponible -> ', err ? JSON.stringify(err).substring(0, 70) : '');
    process.exit(1);
});
