// Deny by default. New endpoints must be explicitly reviewed before support can read them.
// No backup exports, credential settings, or mutation methods are permitted.
const exact=new Set([
 '/api/state','/api/config','/api/attendance-stats','/api/admin/diagnostics',
 '/api/admin/audit','/api/admin/audit/actions','/api/admin/duplicate-characters',
 '/api/admin/gear-sections','/api/admin/skillcores/catalog',
 '/api/admin/discord-check','/api/discord/channels','/api/discord/roles',
 '/api/admin/dm-test','/api/admin/voice-test',
 '/api/shotcaller/status','/api/shotcaller/voice-channels'
]);
const detail=[/^\/api\/events\/\d+\/(tracking-state|voice-track\/live)$/,/^\/api\/gearthreads\/\d+(\/chat)?$/,/^\/api\/merc-event\/\d+$/];
module.exports=(method,pathname)=>method==='GET' && (exact.has(pathname) || detail.some(re=>re.test(pathname)));
