require('dotenv').config();
const path = require('path');
const { spawn } = require('child_process');
const { calcularFechaLimite } = require('./utils/horario.js');

// Tiempo máximo por tarea: evita que un script que no termina bloquee la cola de días siguientes
const MAX_HORAS_TAREA = parseFloat(process.env.ENROL_MAX_HORAS_TAREA) || 23;

// Mapa de día de la semana (0=Domingo, 1=Lunes, ..., 6=Sábado) a la cola de scripts del día.
// Los scripts de un mismo día se ejecutan en serie para no saturar Regula.
// Para enrolar todos los sistemas el mismo día basta con listar varios scripts por día.
const scheduleMap = {
    0: ['enrolamientoICV.js'],   // Domingo
    1: ['enrolamientoAAP.js'],   // Lunes
    2: ['enrolamientoCISEC.js'], // Martes
    3: ['enrolamientoDGA.js'],   // Miércoles
    4: ['enrolamientoICV.js'],   // Jueves
    5: ['enrolamientoAAP.js'],   // Viernes
    6: ['enrolamientoDGA.js'],   // Sábado
};

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

console.log("Iniciando Programador (Scheduler) de Enrolamientos...");
for (const [dia, scripts] of Object.entries(scheduleMap)) {
    console.log(`- ${DIAS[dia]} 1:00 AM: ${scripts.join(' → ')}`);
}
console.log(`- Hora límite: ${process.env.ENROL_HORA_LIMITE || 'sin límite'} | Máximo por tarea: ${MAX_HORAS_TAREA}h`);

let lastRunDay = -1;
let enEjecucion = false;

function ejecutarScript(scriptName, fechaLimite) {
    return new Promise(resolve => {
        const env = { ...process.env };
        if (fechaLimite) env.ENROL_FECHA_LIMITE = fechaLimite.toISOString();

        const child = spawn(process.execPath, [path.join(__dirname, scriptName)], { stdio: 'inherit', cwd: __dirname, env });

        const timeout = setTimeout(() => {
            console.error(`[${new Date().toLocaleString()}] Tarea ${scriptName} excedió ${MAX_HORAS_TAREA}h, se detiene`);
            child.kill();
        }, MAX_HORAS_TAREA * 60 * 60 * 1000);

        child.on('error', (err) => {
            console.error(`[${new Date().toLocaleString()}] No se pudo ejecutar ${scriptName}:`, err.message);
        });

        child.on('close', (code) => {
            clearTimeout(timeout);
            console.log(`[${new Date().toLocaleString()}] Tarea ${scriptName} finalizada con código ${code}`);
            resolve();
        });
    });
}

async function ejecutarCola(scripts) {
    enEjecucion = true;
    const fechaLimite = calcularFechaLimite();

    try {
        for (let i = 0; i < scripts.length; i++) {
            if (fechaLimite && new Date() >= fechaLimite) {
                console.log(`[${new Date().toLocaleString()}] Hora límite alcanzada, se omiten: ${scripts.slice(i).join(', ')}`);
                break;
            }
            console.log(`[${new Date().toLocaleString()}] Ejecutando tarea programada: ${scripts[i]}`);
            await ejecutarScript(scripts[i], fechaLimite);
        }
    } finally {
        enEjecucion = false;
    }
}

function checkTime() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Revisa si son las 01:00 AM, si hay una tarea para hoy, y si no se ha ejecutado hoy
    if (hour === 1 && minute === 0 && scheduleMap[dayOfWeek] && lastRunDay !== dayOfWeek) {
        lastRunDay = dayOfWeek; // Marcar que ya corrió hoy

        if (enEjecucion) {
            console.log(`[${now.toLocaleString()}] La cola anterior sigue en ejecución, se omite: ${scheduleMap[dayOfWeek].join(', ')}`);
        } else {
            ejecutarCola(scheduleMap[dayOfWeek]);
        }
    }

    // Reiniciar la variable de control pasada la media noche
    if (hour === 0 && minute === 0) {
        lastRunDay = -1;
    }
}

// Revisar cada 30 segundos
setInterval(checkTime, 30000);
