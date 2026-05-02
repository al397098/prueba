/**
 * ============================================================
 * SONYA Suite Analítica v3.1 — logic_connector.js
 * Singleton. Gestiona la BBDD JSON por Unidad Funcional,
 * persistencia runtime (localStorage) y enrutamiento a engines.
 *
 * CORRECCIONES v3.1:
 *  - Ruta del fetch resuelta automáticamente según origen del HTML
 *    (raíz vs /public/). No hay ruta hardcodeada.
 *  - Claves JSON mapeadas: unidades_funcionales → getUFs(), etc.
 *  - getAlternatives() aplana scores.{eco,amb,soc} a campo plano
 *    para que TOPSISEngine y MRPEngine reciban {nombre,eco,amb,soc}.
 *  - Guarda runtime por clave compuesta ufId para evitar colisiones.
 *  - getStatus() y getUF() son null-safe.
 * ============================================================
 */

class SonyaConnector {

    constructor() {
        this.database        = null;
        this._storagePrefix  = 'sonya_rt_';
    }

    // ─── Resolución de ruta ──────────────────────────────────
    static _resolveDatabasePath() {
        const path = window.location.pathname;
        if (path.includes('/public/')) {
            return '../data/database.json';
        }
        return './data/database.json';
    }

    // ─── Singleton ───────────────────────────────────────────
    static async init() {
        if (window.__sonyaConnector) return window.__sonyaConnector;

        const instance = new SonyaConnector();
        const url      = SonyaConnector._resolveDatabasePath();

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(
                    `No se pudo cargar database.json (HTTP ${response.status}). ` +
                    `Ruta intentada: "${url}". ` +
                    `Verifica que Live Server tiene como root la carpeta raíz del proyecto.`
                );
            }
            instance.database = await response.json();
        } catch (err) {
            throw new Error(`[SonyaConnector] Error al cargar BBDD: ${err.message}`);
        }

        window.__sonyaConnector = instance;
        return instance;
    }

    // ─── Acceso seguro al mapa de UFs ────────────────────────
    _getUFMap() {
        if (!this.database) return {};
        return this.database.unidades_funcionales
            ?? this.database.functional_units
            ?? {};
    }

    // ─── API pública ─────────────────────────────────────────

    getUFs() {
        const ufMap = this._getUFMap();
        return Object.entries(ufMap).map(([key, uf]) => ({
            id          : key,
            label       : uf.label       ?? key,
            unit        : uf.unidad      ?? uf.unit ?? '',
            description : uf.description ?? '',
            count       : this.getAlternatives(key).length
        }));
    }

    getUF(ufId) {
        const ufMap = this._getUFMap();
        const uf    = ufMap[ufId];
        if (!uf) return null;
        return {
            id          : ufId,
            label       : uf.label       ?? ufId,
            unit        : uf.unidad      ?? uf.unit ?? '',
            description : uf.description ?? '',
            count       : this.getAlternatives(ufId).length
        };
    }

    /**
     * Devuelve alternativas APLANADAS listas para los engines.
     * Normaliza scores:{eco,amb,soc} → eco/amb/soc plano.
     * Combina estáticas (JSON) + runtime (localStorage).
     */
    getAlternatives(ufId) {
        const ufMap = this._getUFMap();
        const uf    = ufMap[ufId];
        if (!uf) return [];

        const rawBase = uf.alternativas ?? uf.alternatives ?? [];
        const base    = rawBase.map(alt => this._flatten(alt, 'static'));
        const runtime = this._loadRuntime(ufId);

        return [...base, ...runtime];
    }

    _flatten(alt, source = 'static') {
        const eco    = alt.scores?.eco ?? alt.eco ?? 0;
        const amb    = alt.scores?.amb ?? alt.amb ?? 0;
        const soc    = alt.scores?.soc ?? alt.soc ?? 0;
        const nombre = alt.label ?? alt.nombre ?? alt.accion ?? '?';
        return {
            id      : alt.id ?? `${source}_${nombre}`,
            nombre,
            tipo    : alt.tipo   ?? 'EX-POST',
            eco     : parseFloat(eco) || 0,
            amb     : parseFloat(amb) || 0,
            soc     : parseFloat(soc) || 0,
            source,
            metadata: alt.metadata ?? {}
        };
    }

    addAlternative(ufId, altData, persist = true) {
        if (!this.getUF(ufId)) throw new Error(`[SonyaConnector] UF desconocida: "${ufId}"`);

        const id     = altData.id ?? `rt_${ufId}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
        const nombre = altData.label ?? altData.nombre ?? altData.accion ?? 'Nueva alternativa';
        const tipo   = altData.tipo  ?? 'EX-POST';
        const eco    = parseFloat(altData.scores?.eco ?? altData.eco) || 0;
        const amb    = parseFloat(altData.scores?.amb ?? altData.amb) || 0;
        const soc    = parseFloat(altData.scores?.soc ?? altData.soc) || 0;

        const flat    = { id, nombre, tipo, eco, amb, soc, source: 'runtime', metadata: altData.metadata ?? {} };
        const runtime = this._loadRuntime(ufId);

        const exists = runtime.find(r => r.nombre.toLowerCase() === nombre.toLowerCase());
        if (exists) throw new Error(`[SonyaConnector] "${nombre}" ya existe en U.F. "${ufId}"`);

        runtime.push(flat);
        if (persist) this._saveRuntime(ufId, runtime);
        return { id, nombre };
    }

    removeAlternative(ufId, altId) {
        const runtime = this._loadRuntime(ufId).filter(a => a.id !== altId);
        this._saveRuntime(ufId, runtime);
    }

    clearRuntimeAlternatives(ufId) { this._saveRuntime(ufId, []); }

    clearAllRuntime() {
        try {
            Object.keys(localStorage)
                .filter(k => k.startsWith(this._storagePrefix))
                .forEach(k => localStorage.removeItem(k));
        } catch (_) {}
    }

    // ─── Motores ─────────────────────────────────────────────

    runTOPSIS(ufId, opts = {}) {
        if (typeof TOPSISEngine === 'undefined')
            throw new Error('[SonyaConnector] topsis_engine.js no está cargado.');
        const data = this.getAlternatives(ufId);
        if (data.length < 2)
            throw new Error(`[SonyaConnector] TOPSIS requiere ≥2 alternativas en "${ufId}" (hay ${data.length}).`);
        return { ...TOPSISEngine.run(data, opts), uf_count: data.length };
    }

    runMRP(ufId, alpha = null, qCustom = null, lineaRoja = null) {
        if (typeof MRPEngine === 'undefined')
            throw new Error('[SonyaConnector] mrp_engine.js no está cargado.');
        const data = this.getAlternatives(ufId);
        if (data.length < 2)
            throw new Error(`[SonyaConnector] MRP requiere ≥2 alternativas en "${ufId}" (hay ${data.length}).`);
        return MRPEngine.run(data, {
            alpha     : alpha     ?? MRPEngine.ALPHA_DEFAULT,
            qCustom   : qCustom   ?? {},
            lineaRoja : lineaRoja ?? MRPEngine.LR_DEFAULT
        });
    }

    // ─── Utilidades ──────────────────────────────────────────

    buildUFSelectHTML(selectedId = '') {
        return this.getUFs().map(uf =>
            `<option value="${uf.id}" ${uf.id === selectedId ? 'selected' : ''}>${uf.label} (${uf.count})</option>`
        ).join('');
    }

    getStatus() {
        const ufs = this.getUFs();
        let total = 0, runtime = 0;
        ufs.forEach(uf => {
            const alts = this.getAlternatives(uf.id);
            total   += alts.length;
            runtime += alts.filter(a => a.source === 'runtime').length;
        });
        return {
            loaded      : !!this.database,
            ufs         : ufs.length,
            totalAlts   : total,
            runtimeAlts : runtime,
            engines     : {
                topsis: typeof TOPSISEngine !== 'undefined',
                mrp   : typeof MRPEngine    !== 'undefined'
            }
        };
    }

    // ─── localStorage helpers ────────────────────────────────

    _storageKey(ufId) { return `${this._storagePrefix}${ufId}`; }

    _loadRuntime(ufId) {
        try { return JSON.parse(localStorage.getItem(this._storageKey(ufId)) || '[]'); }
        catch (_) { return []; }
    }

    _saveRuntime(ufId, arr) {
        try { localStorage.setItem(this._storageKey(ufId), JSON.stringify(arr)); }
        catch (_) {}
    }
}

window.SonyaConnector = SonyaConnector;