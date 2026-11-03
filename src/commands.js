export const commands = [
  { name: 'aura', description: 'Propone puntos de aura para votación', options: [
    { type: 6, name: 'usuario', description: 'Miembro que recibe el aura', required: true },
    { type: 4, name: 'puntos', description: 'Puntos entre -1000 y 1000', required: true, min_value: -1000, max_value: 1000 },
    { type: 3, name: 'motivo', description: 'Por qué merece ese cambio', required: true, max_length: 250 }
  ] },
  { name: 'perfil', description: 'Muestra aura, estadísticas personales y evolución', options: [
    { type: 6, name: 'usuario', description: 'Miembro a consultar', required: false }
  ] },
  { name: 'historial', description: 'Muestra los motivos de los cambios de aura aprobados', options: [
    { type: 6, name: 'usuario', description: 'Miembro a consultar', required: false },
    { type: 4, name: 'pagina', description: 'Página del historial (8 movimientos por página)', required: false, min_value: 1 }
  ] },
  { name: 'votaciones', description: 'Muestra todas las propuestas de aura recibidas y su estado', options: [
    { type: 6, name: 'usuario', description: 'Persona que recibe las propuestas', required: false },
    { type: 4, name: 'pagina', description: 'Página del historial (8 propuestas por página)', required: false, min_value: 1, max_value: 1000000 }
  ] },
  { name: 'ranking', description: 'Muestra las 10 personas con más aura del servidor' },
  { name: 'config', description: 'Consulta o cambia la configuración del servidor', options: [
    { type: 1, name: 'ver', description: 'Muestra las reglas actuales de este servidor' },
    { type: 1, name: 'cambiar', description: 'Cambia reglas para propuestas nuevas (Administrar servidor)', options: [
      { type: 8, name: 'rol', description: 'Rol cuyos votos pueden cerrar una propuesta', required: false },
      { type: 4, name: 'normal', description: 'Votos para cerrar si empata o lidera (1 a 100)', min_value: 1, max_value: 100, required: false },
      { type: 4, name: 'imponerse', description: 'Votos para cerrar aunque vaya perdiendo (normal a 100)', min_value: 1, max_value: 100, required: false },
      { type: 7, name: 'canal', description: 'Canal permitido para propuestas nuevas', channel_types: [0, 5], required: false },
      { type: 5, name: 'canal_libre', description: 'Permitir propuestas en cualquier canal del servidor', required: false }
    ] }
  ] },
  { name: 'moderar', description: 'Panel privado exclusivo para administradores', default_member_permissions: '8', options: [
    { type: 1, name: 'listar', description: 'Lista propuestas del servidor y sus IDs', options: [
      { type: 6, name: 'usuario', description: 'Persona que recibe las propuestas', required: false },
      { type: 3, name: 'estado', description: 'Estado de las propuestas', required: false, choices: [
        { name: 'Abiertas', value: 'open' }, { name: 'Aprobadas', value: 'approved' }, { name: 'Rechazadas', value: 'rejected' },
        { name: 'Vencidas', value: 'expired' }, { name: 'Canceladas', value: 'cancelled' }
      ] },
      { type: 4, name: 'pagina', description: 'Página (8 propuestas por página)', min_value: 1, max_value: 1000000, required: false }
    ] },
    { type: 1, name: 'inspeccionar', description: 'Muestra votos, reglas y estado de una propuesta', options: [
      { type: 3, name: 'propuesta', description: 'ID de la propuesta, disponible en listar', max_length: 100, required: true }
    ] },
    { type: 1, name: 'cancelar', description: 'Cancela una propuesta abierta sin cambiar el aura', options: [
      { type: 3, name: 'propuesta', description: 'ID de la propuesta', max_length: 100, required: true },
      { type: 3, name: 'motivo', description: 'Motivo administrativo privado', min_length: 3, max_length: 250, required: true },
      { type: 5, name: 'confirmar', description: 'true confirma; si se omite, muestra una vista previa', required: false }
    ] },
    { type: 1, name: 'sincronizar', description: 'Reintenta actualizar el mensaje desde D1', options: [
      { type: 3, name: 'propuesta', description: 'ID de la propuesta', max_length: 100, required: true },
      { type: 5, name: 'confirmar', description: 'true confirma; si se omite, muestra una vista previa', required: false },
      { type: 3, name: 'motivo', description: 'Motivo privado del reintento', min_length: 3, max_length: 250, required: false }
    ] },
    { type: 1, name: 'acciones', description: 'Consulta la auditoría administrativa del servidor', options: [
      { type: 3, name: 'propuesta', description: 'Filtrar por ID de propuesta', max_length: 100, required: false },
      { type: 4, name: 'pagina', description: 'Página (8 acciones por página)', min_value: 1, max_value: 1000000, required: false }
    ] }
  ] },
  { name: 'info', description: 'Explica los comandos y las reglas de votación de Ben 10' }
];
