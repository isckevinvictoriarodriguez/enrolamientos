const { initIcvPool, closeIcvPool } = require('./db/icv_config.js');
const { taskOracleCheck } = require('./icvEnrolamiento/enrolamiento.js');

// Inicializar Pool de Oracle (Independiente de MongoDB)
// Se cierra el pool y el proceso al terminar para que el scheduler pueda continuar con la cola
initIcvPool().then(async () => {
    await taskOracleCheck();
    await closeIcvPool();
    process.exit(0);
}).catch(err => {
    console.error('Error servicio Oracle ICV no disponible -> ', err ? JSON.stringify(err).substring(0, 70) : '');
    process.exit(1);
});
