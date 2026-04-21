const { initAapPool } = require('./db/aap_config.js');
const { taskAapCheck } = require('./aapEnrolamientos/enrolamiento.js');

// Inicializar Pool de SQL Server
initAapPool().then(() => {
    taskAapCheck();
}).catch(err => {
    console.error('Error servicio SQL Server AAP no disponible -> ', err ? JSON.stringify(err).substring(0, 70) : '');
});