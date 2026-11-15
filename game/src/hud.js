// The DOM HUD: crosshair, hit marker, health, ammo, money, timer, score,
// alive counts, kill feed, banners, the buy menu — plus the rev-2 layers: a
// live minimap, a Tab scoreboard with K/D and MVP, a settings panel
// (sensitivity, volume, crosshair colour), a directional damage arc, a
// low-health pulse and round-history pips.
//
// This module never touches the simulation. main.js pushes numbers in and
// reads the buy and settings callbacks out; everything in here is just DOM.
import { WEAPONS, WEAPON_ORDER, GRENADE_PRICE } from './weapon.js';

// What each overlay mode says. The match mode takes its body text from the
// caller (the final score line), the others use the copy below.
const OVERLAY_TEXT = {
  start: {
    title: 'SCRAPLINE',
    copy: 'YARD 7 — plant the spike at A or B, or eliminate EMBER. Click to play.',
    action: 'Click to play',
  },
  paused: {
    title: 'SCRAPLINE',
    copy: 'Paused. Click to resume.',
    action: 'Click to resume',
  },
  match: {
    title: 'Match over',
    copy: '',
    action: 'Play again',
  },
};

export function createHud() {
  const grab = (id) => document.getElementById(id);
  // One bag of element handles, so the methods below read short names.
  const el = {
    overlay: grab('overlay'),
    overlayTitle: grab('overlay-title'),
    overlayCopy: grab('overlay-copy'),
    playBtn: grab('play'),
    mag: grab('ammo-mag'),
    reserve: grab('ammo-reserve'),
    gunName: grab('weapon-name'),
    frags: grab('grenade-count'),
    ammoBox: grab('ammo'),
    hpFill: grab('health-fill'),
    hpNum: grab('health-num'),
    hpBox: grab('health-box'),
    cash: grab('money-value'),
    clock: grab('timer-value'),
    scoreA: grab('score-attack'),
    scoreD: grab('score-defend'),
    aliveA: grab('alive-attack'),
    aliveD: grab('alive-defend'),
    feed: grab('killfeed'),
    marker: grab('hitmarker'),
    sight: grab('crosshair'),
    bannerBox: grab('banner'),
    bannerHead: grab('banner-title'),
    bannerBody: grab('banner-sub'),
    vignette: grab('damage-vignette'),
    lowHp: grab('low-health'),
    plantBar: grab('plant-bar'),
    plantFill: grab('plant-fill'),
    plantLabel: grab('plant-label'),
    shop: grab('buy-menu'),
    shopCash: grab('buy-money'),
    shopRound: grab('buy-round'),
    shopGrid: grab('buy-grid'),
    hintLine: grab('hint'),
    map: grab('minimap'),
    board: grab('scoreboard'),
    boardBody: grab('scoreboard-body'),
    boardTitle: grab('scoreboard-title'),
    pips: grab('round-pips'),
    specBar: grab('spectate-bar'),
    specName: grab('spectate-name'),
    settingsBox: grab('settings'),
    arc: grab('damage-arc'),
    dmgLayer: grab('damage-layer'),
  };

  let markerTimer = 0;
  let bannerTimer = 0;
  let lastAmmoKey = '';
  let lastHp = -1;
  let lastCash = -1;
  let lastClock = '';
  let lastScoreKey = '';
  let lastAliveKey = '';
  let lastPipsKey = '';

  const buyListeners = new Set();
  const settingsListeners = new Set();
  const tellBuyers = (id) => { for (const fn of buyListeners) fn(id); };
  const tellSettings = (key, value) => { for (const fn of settingsListeners) fn(key, value); };

  // One buy card per weapon, plus the frag. The card shows the name, the
  // price (or OWNED), a one-line role, and its hotkey.
  function buildCard(id, price, name, role, key) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'buy-card';
    card.dataset.weapon = id;
    card.innerHTML = `<b>${name}</b><span class="buy-price">$${price}</span>`
      + `<span class="buy-desc">${role}</span>`
      + `<span class="buy-key">[${key}]</span>`;
    card.addEventListener('click', () => tellBuyers(id));
    el.shopGrid.appendChild(card);
    return card;
  }
  for (const id of WEAPON_ORDER) {
    const def = WEAPONS[id];
    const role = def.pellets > 1
      ? `${def.pellets} pellets · close range`
      : `${def.damage} dmg · ${def.mag} rnd · ${def.headMult}x head`;
    buildCard(id, def.price, def.name, role, def.slot);
  }
  buildCard('grenade', GRENADE_PRICE, 'SPARK FRAG', 'Bounce, beep, boom · max 2', 'G');

  function paintShop(money, owned, grenades) {
    el.shopCash.textContent = `$${money}`;
    for (const card of el.shopGrid.children) {
      const id = card.dataset.weapon;
      const def = WEAPONS[id];
      const price = def ? def.price : GRENADE_PRICE;
      const haveIt = id === 'grenade' ? grenades >= 2 : owned.has(id);
      card.classList.toggle('owned', Boolean(haveIt));
      card.classList.toggle('cant', money < price && !haveIt);
      const tag = card.querySelector('.buy-price');
      if (tag) tag.textContent = haveIt ? 'OWNED' : `$${price}`;
    }
  }

  // Settings sliders report live while dragged; the crosshair picker
  // reports on change. Each one also updates its own readout label.
  function wireSlider(id, key, format) {
    const slider = grab(id);
    if (!slider) return;
    slider.addEventListener('input', () => {
      const value = Number(slider.value);
      const readout = grab(`${id}-value`);
      if (readout) readout.textContent = format(value);
      tellSettings(key, value);
    });
  }
  wireSlider('setting-sensitivity', 'sensitivity', (v) => v.toFixed(2));
  wireSlider('setting-volume', 'volume', (v) => `${Math.round(v * 100)}%`);
  const crossPicker = grab('setting-crosshair');
  if (crossPicker) {
    crossPicker.addEventListener('change', () => {
      el.sight.style.setProperty('--cross-color', crossPicker.value);
      tellSettings('crosshair', crossPicker.value);
    });
  }

  return {
    minimapCanvas: el.map,
    damageContainer: el.dmgLayer,
    damageArc: el.arc,
    setAmmo(mag, reserve, name, grenades) {
      const key = `${mag}|${reserve}|${name}|${grenades}`;
      if (key === lastAmmoKey) return;
      lastAmmoKey = key;
      el.mag.textContent = String(mag);
      el.reserve.textContent = `/ ${reserve}`;
      el.gunName.textContent = name;
      el.frags.textContent = `◉ ${grenades}`;
      el.ammoBox.classList.toggle('empty', mag === 0);
    },
    setHealth(hp) {
      const shown = Math.max(0, Math.round(hp));
      if (shown === lastHp) return;
      lastHp = shown;
      el.hpFill.style.width = `${shown}%`;
      el.hpNum.textContent = String(shown);
      el.hpFill.classList.toggle('low', shown <= 30);
      el.hpBox.classList.toggle('critical', shown <= 30);
      el.lowHp.classList.toggle('on', shown > 0 && shown <= 30);
    },
    setMoney(value) {
      if (value === lastCash) return;
      lastCash = value;
      el.cash.textContent = `$${value}`;
    },
    setTimer(text, planted) {
      if (text === lastClock) return;
      lastClock = text;
      el.clock.textContent = text;
      el.clock.classList.toggle('planted', Boolean(planted));
    },
    setScore(attack, defend) {
      const key = `${attack}-${defend}`;
      if (key === lastScoreKey) return;
      lastScoreKey = key;
      el.scoreA.textContent = String(attack);
      el.scoreD.textContent = String(defend);
    },
    setRoundPips(history) {
      const key = history.join('');
      if (key === lastPipsKey) return;
      lastPipsKey = key;
      el.pips.innerHTML = '';
      for (const winner of history) {
        const pip = document.createElement('span');
        pip.className = `pip ${winner === 'attack' ? 'van' : 'emb'}`;
        pip.textContent = '●';
        el.pips.appendChild(pip);
      }
    },
    setAlive(attack, defend) {
      const key = `${attack}|${defend}`;
      if (key === lastAliveKey) return;
      lastAliveKey = key;
      el.aliveA.textContent = '●'.repeat(attack) + '○'.repeat(4 - attack);
      el.aliveD.textContent = '●'.repeat(defend) + '○'.repeat(4 - defend);
    },
    setCrosshair(gapPx) {
      el.sight.style.setProperty('--gap', `${Math.round(gapPx)}px`);
    },
    killfeed(text, good) {
      const line = document.createElement('div');
      line.className = `feed-line${good ? ' good' : ''}`;
      line.textContent = text;
      el.feed.prepend(line);
      while (el.feed.children.length > 5) el.feed.lastChild.remove();
      setTimeout(() => line.remove(), 6000);
    },
    hitMarker(killed, holdMs = 90) {
      el.marker.classList.add('on');
      el.marker.classList.toggle('kill', killed);
      clearTimeout(markerTimer);
      markerTimer = setTimeout(() => el.marker.classList.remove('on', 'kill'), holdMs);
    },
    damageFlash() {
      el.vignette.classList.add('on');
      setTimeout(() => el.vignette.classList.remove('on'), 180);
    },
    banner(head, body, holdMs = 2400) {
      el.bannerHead.textContent = head;
      el.bannerBody.textContent = body;
      el.bannerBox.hidden = false;
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => { el.bannerBox.hidden = true; }, holdMs);
    },
    hideBanner() {
      el.bannerBox.hidden = true;
      clearTimeout(bannerTimer);
    },
    setHint(text) {
      el.hintLine.textContent = text;
      el.hintLine.hidden = !text;
    },
    plantProgress(progress, label) {
      if (progress == null) {
        el.plantBar.hidden = true;
        return;
      }
      el.plantBar.hidden = false;
      el.plantFill.style.width = `${Math.round(progress * 100)}%`;
      el.plantLabel.textContent = label;
    },
    showBuy(money, owned, grenades, round) {
      el.shopRound.textContent = String(round || 1);
      paintShop(money, owned, grenades);
      el.shop.hidden = false;
    },
    hideBuy() {
      el.shop.hidden = true;
    },
    refreshBuy: paintShop,
    onBuy(handler) {
      buyListeners.add(handler);
    },
    onSettings(handler) {
      settingsListeners.add(handler);
    },
    showScoreboard(rows, titleText) {
      el.boardTitle.textContent = titleText || 'SCOREBOARD';
      el.boardBody.innerHTML = '';
      for (const r of rows) {
        const tr = document.createElement('tr');
        const kd = r.deaths > 0 ? (r.kills / r.deaths).toFixed(2) : String(r.kills);
        tr.innerHTML = `<td class="${r.team}">${r.name}</td><td>${r.kills}</td><td>${r.deaths}</td>`
          + `<td>${kd}</td><td>${r.damage}</td><td>${r.plants + r.defuses}</td>`;
        el.boardBody.appendChild(tr);
      }
      el.board.hidden = false;
    },
    hideScoreboard() {
      el.board.hidden = true;
    },
    showSpectate(name) {
      el.specName.textContent = name;
      el.specBar.hidden = false;
    },
    hideSpectate() {
      el.specBar.hidden = true;
    },
    showSettings(show) {
      if (el.settingsBox) el.settingsBox.hidden = !show;
    },
    showOverlay(mode, scoreText) {
      const text = OVERLAY_TEXT[mode] || OVERLAY_TEXT.start;
      el.overlayTitle.textContent = text.title;
      el.overlayCopy.textContent = mode === 'match' ? scoreText : text.copy;
      el.playBtn.textContent = text.action;
      el.overlay.hidden = false;
      el.playBtn.focus();
    },
    hideOverlay() {
      el.overlay.hidden = true;
    },
    onPlay(handler) {
      el.playBtn.addEventListener('click', handler);
    },
  };
}
