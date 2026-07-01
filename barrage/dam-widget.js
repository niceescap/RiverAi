/**
 * dam-widget.js
 * -------------
 * MOTEUR PHYSIQUE ET API DU BARRAGE
 *
 * Ce fichier contient toute la logique : gestion du niveau d'eau,
 * animation de la pluie, reservation des depenses, WebSocket.
 *
 * A NE PAS MODIFIER sans maitriser la logique.
 * Le graphiste n'a pas besoin d'y toucher.
 *
 * API exposee sur window.dam :
 *   setLevel(tokens)               -> fixe le niveau absolu
 *   setCapacity(tokens)            -> fixe la capacite max
 *   setRiverRate(tokens/s)         -> apport continu
 *   setValveOpening(0..1)          -> ouverture de la vanne principale
 *   simulateRain(amount, duration) -> recharge animee (en s)
 *   installSpend(id, costM)        -> propose une depense (cost en M tokens)
 *   validateSpend(id)              -> valide et deduit la depense
 *   cancelSpend(id)                -> annule la proposition
 *
 * Protocole WebSocket accepte (JSON) :
 *   { "cmd": "set_level", "val": 45000000 }
 *   { "cmd": "set_river", "val": 1500000 }
 *   { "cmd": "set_valve", "val": 0.5 }
 *   { "cmd": "simulate_rain", "val": {"amount": 5000000, "duration": 3} }
 *   { "cmd": "install_spend", "val": {"id": "rag-1", "cost": 2.5} }
 *   { "cmd": "validate_spend", "val": "rag-1" }
 *   { "cmd": "cancel_spend", "val": "rag-1" }
 */

(function (root) {
  'use strict';

  const M = 1_000_000;
  let spendCounter = 0;

  class DamWidget {
    constructor(options = {}) {
      this.capacity = options.capacity || 100 * M;
      this.level = Math.max(0, Math.min(this.capacity, options.initialLevel || 0));
      this.riverRate = 0;
      this.maxOutputRate = options.maxOutputRate || 5 * M;
      this.valveOpening = 0;

      this.temporarySpends = new Map();
      this.events = [];

      this.wsUrl = options.wsUrl || null;
      this.ws = null;

      this.running = false;
      this.lastTs = 0;

      this.rain = { active: false, until: 0, fromLevel: 0, targetLevel: 0 };

      this.els = this.cacheDOM();
      this.render(true);
    }

    cacheDOM() {
      return {
        conn: document.getElementById('connStatus'),
        riverValue: document.getElementById('riverValue'),
        valveValue: document.getElementById('valveValue'),
        fillPct: document.getElementById('fillPct'),
        levelVol: document.getElementById('levelVol'),
        water: document.getElementById('water'),
        reservoir: document.getElementById('reservoir'),
        outputJet: document.getElementById('outputJet'),
        rainOverlay: document.getElementById('rainOverlay'),
        gaugeArc: document.getElementById('gaugeArc'),
        gaugeNeedle: document.getElementById('gaugeNeedle'),
        gaugeValueText: document.getElementById('gaugeValueText'),
        netRateText: document.getElementById('netRateText'),
        timeFull: document.getElementById('timeFull'),
        timeEmpty: document.getElementById('timeEmpty'),
        spendList: document.getElementById('spendList'),
        eventList: document.getElementById('eventList'),
      };
    }

    /* === WEBSOCKET : connection au backend Python === */
    connect(url = this.wsUrl) {
      if (!url) return;
      this.wsUrl = url;
      this._openWs();
    }

    _openWs() {
      try { this.ws = new WebSocket(this.wsUrl); }
      catch (e) {
        this._setConn(false);
        setTimeout(() => this._openWs(), 3000);
        return;
      }
      this.ws.onopen = () => this._setConn(true);
      this.ws.onclose = () => { this._setConn(false); setTimeout(() => this._openWs(), 3000); };
      this.ws.onerror = () => { try { this.ws.close(); } catch (e) {} };
      this.ws.onmessage = (e) => {
        try { const data = JSON.parse(e.data); this.handleCommand(data.cmd, data.val); }
        catch (err) { console.error('WS message error', err); }
      };
    }

    _setConn(connected) {
      if (!this.els.conn) return;
      this.els.conn.classList.toggle('connected', connected);
      this.els.conn.textContent = connected ? '● Connecté' : '● Hors ligne';
    }

    /* === API PUBLIQUE === */
    setLevel(value) {
      this.level = Math.max(0, Math.min(this.capacity, value));
      this.render();
    }

    setCapacity(value) {
      this.capacity = Math.max(1, value);
      this.level = Math.min(this.level, this.capacity);
      this.render();
    }

    setRiverRate(rate) {
      this.riverRate = Math.max(0, rate);
      this.render();
    }

    setValveOpening(opening) {
      this.valveOpening = Math.max(0, Math.min(1, opening));
      this.render();
    }

    /** Recharge animee : pluie pendant 'duration' secondes. */
    simulateRain(amount, duration = 3) {
      if (amount <= 0) return;
      const now = performance.now();
      this.rain = {
        active: true,
        until: now + duration * 1000,
        fromLevel: this.level,
        targetLevel: this.level + amount,
      };
      this.logEvent(`Recharge spot +${this.formatM(amount)} M`);
    }

    /** Propose une depense ponctuelle. costM est en millions de tokens. */
    installSpend(id, costM) {
      const cost = (parseFloat(costM) || 0) * M;
      if (cost <= 0) return null;
      spendCounter += 1;
      const idSafe = id || `spend-${spendCounter}`;
      this.temporarySpends.set(idSafe, { id: idSafe, cost });
      this.renderSpends();
      return idSafe;
    }

    validateSpend(id) {
      const spend = this.temporarySpends.get(id);
      if (!spend) return false;
      if (this.level < spend.cost) {
        this.logEvent(`❌ Solde insuffisant : dépense ${spend.id}`);
        return false;
      }
      this.level -= spend.cost;
      this.logEvent(`✅ Dépense validée : -${this.formatM(spend.cost)} M`);
      this.temporarySpends.delete(id);
      this.render();
      this.renderSpends();
      return true;
    }

    cancelSpend(id) {
      this.temporarySpends.delete(id);
      this.renderSpends();
    }

    addSpendFromUI() {
      const cost = parseFloat(document.getElementById('spendCost')?.value) || 0;
      if (cost <= 0) return;
      this.installSpend(null, cost);
    }

    /* === BOUCLE DE SIMULATION === */
    startSimulation() {
      if (this.running) return;
      this.running = true;
      this.lastTs = performance.now();
      this.loop();
      this.connect();
    }

    stopSimulation() { this.running = false; }

    loop() {
      if (!this.running) return;
      const now = performance.now();
      const dt = Math.min((now - this.lastTs) / 1000, 1);
      this.lastTs = now;

      this.updatePhysics(now, dt);
      this.render();

      requestAnimationFrame(() => this.loop());
    }

    updatePhysics(now, dt) {
      const outflow = this.valveOpening * this.maxOutputRate;

      if (this.rain.active) {
        const elapsed = now - (this.rain.until - 3000);
        const t = Math.max(0, Math.min(1, elapsed / 3000));
        this.level = this.rain.fromLevel + (this.rain.targetLevel - this.rain.fromLevel) * t;
        this.rain.active = now < this.rain.until;
      } else {
        this.level += (this.riverRate - outflow) * dt;
      }

      this.level = Math.max(0, Math.min(this.capacity, this.level));
    }

    /* === RENDU === */
    render(force = false) {
      const ratio = this.level / this.capacity;
      const outflow = this.valveOpening * this.maxOutputRate;
      const net = this.riverRate - outflow;

      this.setText(this.els.riverValue, this.formatM(this.riverRate));
      this.setText(this.els.valveValue, this.formatM(outflow));
      this.setText(this.els.levelVol, this.formatM(this.level));
      this.setText(this.els.fillPct, this.formatPct(ratio));

      if (this.els.water) {
        this.els.water.style.height = this.formatPct(ratio) + '%';
      }

      if (this.els.outputJet) {
        this.els.outputJet.style.height = Math.round(this.valveOpening * 70) + 'px';
      }

      if (this.els.rainOverlay) {
        this.els.rainOverlay.classList.toggle('active', this.rain.active);
      }

      this.renderGauge(this.valveOpening);
      this.renderForecast(net);

      if (force) {
        this.renderSpends();
        this.renderEvents();
      }
    }

    renderGauge(opening) {
      if (!this.els.gaugeArc || !this.els.gaugeNeedle) return;
      const arcLen = 251;
      this.els.gaugeArc.setAttribute('stroke-dashoffset', arcLen * (1 - opening));
      if (this.els.gaugeValueText) {
        this.els.gaugeValueText.textContent = this.formatPct(opening) + '%';
      }
      const angle = Math.PI * (1 - opening);
      const cx = 100 + 80 * Math.cos(Math.PI - angle);
      const cy = 100 - 80 * Math.sin(angle);
      this.els.gaugeNeedle.setAttribute('cx', cx);
      this.els.gaugeNeedle.setAttribute('cy', cy);
    }

    renderForecast(net) {
      if (!this.els.netRateText || !this.els.timeFull || !this.els.timeEmpty) return;

      const prefix = net >= 0 ? '+' : '';
      this.els.netRateText.textContent = `${prefix}${this.formatM(net)} M/s`;
      this.els.netRateText.className = 'value ' + (net > 0 ? 'pos' : net < 0 ? 'neg' : '');

      if (net > 0) {
        this.setText(this.els.timeFull, this.formatDuration((this.capacity - this.level) / net));
        this.setText(this.els.timeEmpty, '—');
      } else if (net < 0) {
        this.setText(this.els.timeFull, '—');
        this.setText(this.els.timeEmpty, this.formatDuration(-this.level / net));
      } else {
        this.setText(this.els.timeFull, '—');
        this.setText(this.els.timeEmpty, '—');
      }
    }

    /** Met a jour les zones reserves dans le reservoir sans recreer le DOM a chaque frame. */
    renderSpends() {
      const list = this.els.spendList;
      if (!list || !this.els.reservoir) return;

      const existingZones = new Map();
      this.els.reservoir.querySelectorAll('.reserved-water').forEach(el => {
        existingZones.set(el.dataset.id, el);
      });
      this.els.reservoir.querySelectorAll('.level-marker').forEach(el => el.remove());

      const idsInDOM = new Set();

      this.temporarySpends.forEach((spend) => {
        idsInDOM.add(spend.id);
        const projectedLevel = Math.max(0, this.level - spend.cost);
        const levelPct = this.level / this.capacity;
        const projPct = projectedLevel / this.capacity;
        const top = (1 - levelPct) * 100;
        const height = Math.max(0, (levelPct - projPct) * 100);

        let zone = existingZones.get(spend.id);
        if (!zone) {
          zone = document.createElement('div');
          zone.className = 'reserved-water';
          zone.dataset.id = spend.id;
          this.els.reservoir.appendChild(zone);
        }
        zone.style.top = top + '%';
        zone.style.height = height + '%';

        const marker = document.createElement('div');
        marker.className = 'level-marker';
        marker.style.top = ((1 - projPct) * 100) + '%';
        this.els.reservoir.appendChild(marker);
      });

      existingZones.forEach((el, id) => { if (!idsInDOM.has(id)) el.remove(); });

      if (!this.temporarySpends.size) {
        list.innerHTML = '<div class="empty-msg">Aucune dépense en attente</div>';
        return;
      }

      list.innerHTML = Array.from(this.temporarySpends.values()).map(spend => `
        <div class="spend-item" data-id="${spend.id}">
          <div class="line">
            <span class="cost">Coût réservé : ${this.formatM(spend.cost)} M tokens</span>
          </div>
          <div class="actions">
            <button class="btn btn-secondary" onclick="window.dam.cancelSpend('${spend.id}')">Annuler</button>
            <button class="btn btn-warning" onclick="window.dam.validateSpend('${spend.id}')">⚡ Valider</button>
          </div>
        </div>
      `).join('');
    }

    renderEvents() {
      const list = this.els.eventList;
      if (!list) return;
      if (!this.events.length) {
        list.innerHTML = '<div class="empty-msg">Aucun événement</div>';
        return;
      }
      list.innerHTML = this.events.slice().reverse().slice(0, 20).map(e =>
        `<div class="event"><span class="dot"></span>${this.escapeHtml(e)}</div>`
      ).join('');
    }

    logEvent(text) {
      this.events.push(text);
      if (this.events.length > 50) this.events.shift();
      this.renderEvents();
    }

    /* === OUTILS === */
    setText(el, text) { if (el && el.textContent !== String(text)) el.textContent = text; }
    formatM(value) { return (value / M).toFixed(2); }
    formatPct(value) { return (value * 100).toFixed(0); }

    formatDuration(s) {
      if (!isFinite(s) || s < 0) return '—';
      if (s < 60) return Math.round(s) + 's';
      if (s < 3600) return (s / 60).toFixed(1) + 'min';
      if (s < 86400) return (s / 3600).toFixed(1) + 'h';
      return (s / 86400).toFixed(1) + 'j';
    }

    escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    /* === RECEPTION DES COMMANDES WEBSOCKET === */
    handleCommand(cmd, val) {
      switch (cmd) {
        case 'set_level':          this.setLevel(val); break;
        case 'set_capacity':       this.setCapacity(val); break;
        case 'set_river':          this.setRiverRate(val); break;
        case 'set_valve':          this.setValveOpening(val); break;
        case 'simulate_rain':      this.simulateRain(val.amount, val.duration); break;
        case 'install_spend':      this.installSpend(val.id, val.cost); break; // cost en M
        case 'validate_spend':     this.validateSpend(val); break;
        case 'cancel_spend':       this.cancelSpend(val); break;
        case 'log_event':          this.logEvent(val); break;
        default: console.warn('Commande inconnue', cmd);
      }
    }
  }

  root.DamWidget = DamWidget;
})(window);
