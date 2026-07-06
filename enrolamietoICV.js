const { initIcvPool } = require('./db/icv_config.js');
const { taskOracleCheck } = require('./icvEnrolamiento/enrolamiento.js');

// Inicializar Pool de Oracle (Independiente de MongoDB)
initIcvPool().then(() => {
    taskOracleCheck();
}).catch(err => {
    console.error('Error servicio Oracle ICV no disponible -> ', err ? JSON.stringify(err).substring(0, 70) : '');
});