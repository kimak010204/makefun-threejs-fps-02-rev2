// Match statistics: every fighter's kills, deaths, damage dealt, plants and
// defuses, plus the round-by-round history and the MVP. The HUD reads this
// for the Tab scoreboard and the end-of-match panel; nothing here touches the
// simulation itself.
export function createScoreboard() {
  const rows = new Map();
  const history = [];
  let firstBloodDone = false;

  function rowFor(name, team) {
    if (!rows.has(name)) {
      rows.set(name, { name, team, kills: 0, deaths: 0, damage: 0, plants: 0, defuses: 0 });
    }
    return rows.get(name);
  }

  function scoreOf(r) {
    return r.kills * 100 + r.damage + r.plants * 150 + r.defuses * 150;
  }

  return {
    register(name, team) {
      rowFor(name, team);
    },
    recordKill(killer, victim, damageDealt) {
      if (killer) rowFor(killer.name, killer.team).kills += 1;
      if (victim) rowFor(victim.name, victim.team).deaths += 1;
      if (damageDealt != null && killer) rowFor(killer.name, killer.team).damage += damageDealt;
      if (!firstBloodDone) {
        firstBloodDone = true;
        return true;
      }
      return false;
    },
    recordDamage(dealer, amount) {
      if (dealer) rowFor(dealer.name, dealer.team).damage += amount;
    },
    recordPlant(name) {
      rowFor(name, 'attack').plants += 1;
    },
    recordDefuse(name) {
      rowFor(name, 'defend').defuses += 1;
    },
    recordRound(winner) {
      history.push(winner);
    },
    resetMatch() {
      rows.clear();
      history.length = 0;
      firstBloodDone = false;
    },
    resetRound() {
      firstBloodDone = false;
    },
    table() {
      return [...rows.values()].sort((a, b) => scoreOf(b) - scoreOf(a));
    },
    mvp() {
      const ranked = this.table();
      return ranked.length ? ranked[0] : null;
    },
    rounds() {
      return history.slice();
    },
    line(name) {
      return rows.get(name) || null;
    },
  };
}
