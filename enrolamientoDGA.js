require('dotenv').config();
const { taskDgaCheck } = require('./dgaEnrolamientos/enrolamiento.js');

// Ejecutar el proceso de enrolamiento DGA
taskDgaCheck();
