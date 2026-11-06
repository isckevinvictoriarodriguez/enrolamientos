# enrolamientos
Servicio Enrolamiento

# Scheduler (pm2: scheduler-enrolamientos)
Dos carriles, cada uno con su candado (variables en `.env.example`):
- Frecuente: `ENROL_FUENTES` (ICV → AAP → CISEC) en serie cada `ENROL_INTERVALO_MIN` (10) minutos, sin hora límite.
  Cada fuente solo consulta pendientes y envía como máximo `*_MAX_REGISTROS` por vuelta.
- Diario: DGA a `ENROL_DGA_HORA` (01:00); recorre toda su API, respeta `ENROL_HORA_LIMITE`.

Correr una fuente a mano solo si su carril no está en ejecución (las corridas encimadas reenvían registros):
node enrolamientoICV.js

# Descargar fotos
node getFotoCISEC.js p_curp NQPA981125422
node getFotoCISEC.js p_id 123
