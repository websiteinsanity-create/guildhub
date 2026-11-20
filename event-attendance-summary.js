'use strict';

// Counts only: safe to expose even when another player's raw attendance is hidden.
// Keep the same active, non-mercenary, joined-before-event roster as the event UI.
module.exports = function eventAttendanceSummary(event, members, leaves, dateKey, pinOpen = false) {
  const at = Date.parse(event.start), attended = new Set(event.attended || []);
  const overrides = new Set(event.loaOverride || []);
  const result = { tracked: !!event.attendanceTracked, inProgress: !!event.voiceTracking?.active || pinOpen,
    total: 0, present: 0, noShow: 0, notRecorded: 0, onLeave: 0, roles: {} };
  for (const member of members) {
    if (!member.active || member.mercenary || (member.joinedAt && Date.parse(member.joinedAt) > at)) continue;
    const leave = leaves.some(l => l.ownerKey === member.owner && l.status === 'approved' && l.from <= dateKey && dateKey <= l.to);
    // A saved attendance credit remains visible even if the player was on leave.
    if (leave && !overrides.has(member.owner) && !attended.has(member.id)) { result.onLeave++; continue; }
    result.total++;
    if (!result.tracked) continue;
    if (attended.has(member.id)) { result.present++; result.roles[member.role] = (result.roles[member.role] || 0) + 1; }
    else if (event.rsvps?.[member.id] === 'yes') result.noShow++;
    else result.notRecorded++;
  }
  return result;
};
