// Guild Hall audit log: a record of administrative and member actions, so the leadership can see who changed
// what and when. Other modules call ctx.audit(user, action, target, description, before, after) right where a
// change happens (the same place that already knows the old and new values), rather than through a generic
// wrapper that would have to guess at what changed.

module.exports = function install(ctx) {
  const { route, need, clean, newId, save, isOfficer } = ctx;
  const db = () => ctx.db;
  const now = () => new Date().toISOString();

  // user: the person who did it ({key, name}), or null for something the system itself did (a scheduled job).
  // action: a short machine-readable "area.verb", for example 'member.create', 'event.delete', 'settings.update'.
  // target: { type, id, name } - the thing that was acted on. Any part can be left out.
  // description: one plain sentence for the log list.
  // before / after: optional plain objects with ONLY the fields that changed (not whole records) - keeps entries
  // small and avoids storing more of a player's data than the one change actually needed.
  function log(user, action, target, description, before, after) {
    try {
      const D = db();
      D.auditLog = D.auditLog || [];
      D.auditLog.push({
        id: newId(), at: now(),
        byKey: (user && user.key) || '', byName: (user && user.name) || 'System',
        action: String(action || '').slice(0, 60),
        targetType: (target && target.type) || '', targetId: target && target.id != null ? String(target.id) : '', targetName: clean(target && target.name, 80),
        description: clean(description, 400),
        before: before && typeof before === 'object' ? before : null,
        after: after && typeof after === 'object' ? after : null,
      });
      if (D.auditLog.length > 5000) D.auditLog.splice(0, 1000);   // hard cap: once it reaches 5000, drop the oldest 1000 at once (not a rolling trim)
      save();
    } catch { /* logging must never be the reason a real action fails */ }
  }

  // The distinct action types seen so far, for the filter dropdown - cheaper than shipping a fixed list that
  // would need updating by hand every time a new action type is added somewhere in the app.
  route('GET', '/api/admin/audit/actions', () => [...new Set(db().auditLog.map((e) => e.action))].sort(), { officer: true });

  route('GET', '/api/admin/audit', ({ query }) => {
    const all = db().auditLog;
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50));
    const from = query.from ? Date.parse(query.from) : null;
    const to = query.to ? Date.parse(query.to) + 864e5 : null;              // the whole "to" day, inclusive
    const userQ = clean(query.user, 100).toLowerCase();
    const actionQ = clean(query.action, 60);
    const targetQ = clean(query.target, 100).toLowerCase();
    let rows = all.filter((e) => {
      if (from != null && Date.parse(e.at) < from) return false;
      if (to != null && Date.parse(e.at) >= to) return false;
      if (userQ && !(e.byName.toLowerCase().includes(userQ) || e.byKey.toLowerCase().includes(userQ))) return false;
      if (actionQ && e.action !== actionQ) return false;
      if (targetQ && !(e.targetName.toLowerCase().includes(targetQ) || e.targetId.toLowerCase().includes(targetQ) || e.targetType.toLowerCase().includes(targetQ))) return false;
      return true;
    });
    rows = rows.slice().sort((a, b) => b.at.localeCompare(a.at));           // newest first
    const total = rows.length, pages = Math.max(1, Math.ceil(total / limit));
    return { entries: rows.slice((page - 1) * limit, page * limit), total, page: Math.min(page, pages), pages, limit };
  }, { officer: true });

  return { log };
};
