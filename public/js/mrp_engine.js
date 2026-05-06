/**
 * ============================================================
 * SONYA Suite Analítica v3.0 — mrp_engine.js
 * Motor CRITIC + MRP (Multi-Reference Point)
 * Sostenibilidad Fuerte: Veto de Leontief no-compensatorio.
 *
 * PIPELINE (8 pasos, conforme a presentacion_mrp.html):
 *  1. Matriz de decisión X [m × n]
 *  2. Umbrales físicos Q = {q0..q4} por criterio
 *     → Auto: percentiles P100/P75/P50/P25/P0 de la muestra
 *     → Manual: qCustom provisto externamente
 *     Convención de dirección:
 *       cost    (eco, amb): q0=peor(máximo raw) → q4=mejor(mínimo raw)
 *       benefit (soc):      q0=peor(mínimo raw) → q4=mejor(máximo raw)
 *  3. Escala semántica α = [0, 1, 2.5, 3, 4]
 *     α1 = 1.0 define la Línea Roja (nivel de reserva técnica)
 *  4. Función de transferencia s(x_ij) por interpolación lineal
 *     entre los dos umbrales físicos más cercanos al valor real.
 *     Extrapolación lineal si el valor cae fuera del rango [q0, q4].
 *  5. Matriz de logro S = [s_ij]  con s_ij ∈ ℝ (puede ser < 0)
 *  6. Operador de Leontief:  SS(A_i) = min_j { s_ij }
 *     El criterio más rezagado dicta el resultado. Sin compensación.
 *  7. Condición de Veto:  si SS(A_i) < lineaRoja → VETADA
 *     El veto es estructural: no puede ser superado por otros criterios.
 *  8. Ranking por SS descendente. Veredicto según lineaRoja.
 *
 * CRITERIOS:
 *   eco  → cost    (minimizar; q0=máximo raw, q4=mínimo raw)
 *   amb  → cost    (minimizar; q0=máximo raw, q4=mínimo raw)
 *   soc  → benefit (maximizar; q0=mínimo raw, q4=máximo raw)
 *
 * PESOS CRITIC:
 *   Calculados sobre la matriz raw normalizada (Min-Max),
 *   siguiendo la misma metodología que topsis_engine.js para
 *   coherencia interna del sistema. Los pesos informan qué
 *   criterio tiene mayor capacidad discriminante, pero NO
 *   participan en la agregación Leontief (que es un min puro).
 *   Se exponen en el resultado para la tabla de transparencia.
 *
 * EXPOSICIÓN GLOBAL:
 *   window.MRPEngine.run(data, opts) → resultado completo
 *
 * DEPENDENCIA: ninguna (vanilla JS ES6+)
 * ============================================================
 */

const MRPEngine = (() => {

  // ─── Constantes del modelo ───────────────────────────────────

  /**
   * Escala semántica de satisfacción sistémica.
   * α0=0 (Inaceptable) | α1=1 (Reserva/Alerta) |
   * α2=2.5 (Estándar)  | α3=3 (Alto)            | α4=4 (Ideal)
   */
  const ALPHA_DEFAULT = [0, 1, 2.5, 3, 4];

  /**
   * Línea Roja de Veto: α mínimo que debe alcanzar SS(A_i).
   * Si SS < LR_DEFAULT → Veto Técnico estructural.
   */
  const LR_DEFAULT = 1.0;

  /** Tolerancia numérica para denominadores nulos. */
  const EPS = 1e-10;

  // ─── Definición de criterios ─────────────────────────────────
  const CRITERIA = [
    { key: 'eco', label: 'Economic', nature: 'cost'    },
    { key: 'amb', label: 'Environmental', nature: 'cost'    },
    { key: 'soc', label: 'Social',    nature: 'cost' }
  ];

  // ════════════════════════════════════════════════════════════
  // PASO 1 — Extracción de la matriz de decisión raw
  // ════════════════════════════════════════════════════════════
  function _buildMatrix(data) {
    return {
      X      : data.map(d => CRITERIA.map(c => parseFloat(d[c.key]) || 0)),
      labels : data.map(d => d.nombre),
      tipos  : data.map(d => d.tipo ?? 'EX-POST')
    };
  }

  // ════════════════════════════════════════════════════════════
  // PASO 2 — Umbrales físicos Q por criterio (percentiles)
  //
  // Para criterios cost (eco, amb):
  //   Ordenar ascendente, luego invertir → q0=P100(peor), q4=P0(mejor)
  //   Así q0 > q1 > q2 > q3 > q4  [valores raw decrecientes = mejor]
  //
  // Para criterios benefit (soc):
  //   Ordenar ascendente sin invertir → q0=P0(peor), q4=P100(mejor)
  //   Así q0 < q1 < q2 < q3 < q4  [valores raw crecientes = mejor]
  //
  // Percentil lineal: P(t) = s[l]·(1-w) + s[u]·w
  //   donde l=floor(i), u=ceil(i), w=i-l, i=(n-1)·t
  // ════════════════════════════════════════════════════════════
  function _percentile(sortedArr, t) {
    const n = sortedArr.length;
    if (n === 0) return 0;
    if (n === 1) return sortedArr[0];
    const idx = (n - 1) * t;
    const l   = Math.floor(idx);
    const u   = Math.ceil(idx);
    const w   = idx - l;
    return sortedArr[l] * (1 - w) + sortedArr[u] * w;
  }

  function _computeThresholds(X) {
    const thresholds = {};

    CRITERIA.forEach((crit, j) => {
      const col    = X.map(row => row[j]);
      const sorted = col.slice().sort((a, b) => a - b); // ascendente

      // Cinco percentiles: P0, P25, P50, P75, P100
      const p = [0, 0.25, 0.5, 0.75, 1].map(t => _percentile(sorted, t));
      // p[0]=mínimo, p[4]=máximo

      let q;
      if (crit.nature === 'cost') {
        // q0=máximo(peor raw), q4=mínimo(mejor raw) → array decreciente
        q = [p[4], p[3], p[2], p[1], p[0]];
      } else {
        // benefit: q0=mínimo(peor raw), q4=máximo(mejor raw) → array creciente
        q = [p[0], p[1], p[2], p[3], p[4]];
      }

      thresholds[crit.key] = q; // Array[5] de valores raw
    });

    return thresholds;
  }

  // Convierte qCustom externo (formato heredado del motor_mrp.html)
  // que puede llegar como { Amb:[...], Eco:[...], Soc:[...] }
  // (arrays de números o de objetos {valor:number})
  // → formato interno { eco:[...], amb:[...], soc:[...] }
  function _normalizeCustomQ(qCustom) {
    const keyMap = { Eco: 'eco', Amb: 'amb', Soc: 'soc' };
    const out = {};
    Object.entries(qCustom).forEach(([k, arr]) => {
      const internalKey = keyMap[k] ?? k.toLowerCase();
      out[internalKey] = arr.map(v => (typeof v === 'object' ? v.valor : v));
    });
    return out;
  }

  // ════════════════════════════════════════════════════════════
  // PASO 4 — Función de transferencia s(x_ij)
  //
  // Localiza x en el tramo [q[k-1], q[k]] y aplica interpolación:
  //   s(x) = α[k-1] + (α[k] - α[k-1]) / (q[k] - q[k-1]) · (x - q[k-1])
  //
  // La dirección del vector q determina si es cost o benefit:
  //   cost:    q[0] > q[1] > ... > q[4]  (decreciente)
  //   benefit: q[0] < q[1] < ... < q[4]  (creciente)
  //
  // Extrapolación lineal si x cae fuera del rango [min(q), max(q)]:
  //   Más allá del inaceptable (q0): pendiente del tramo [q0,q1]
  //   Más allá del ideal (q4):       pendiente del tramo [q3,q4]
  //
  // Para criterios cost, "fuera del inaceptable" = x > q[0] (peor raw)
  // Para criterios benefit, "fuera del inaceptable" = x < q[0] (peor raw)
  // La lógica unificada se basa en comparar con q[0] y q[4] según
  // si el vector es decreciente o creciente.
  // ════════════════════════════════════════════════════════════
  function _interpolate(x, q, alpha) {
    // q[0]=inaceptable, q[4]=ideal (dirección ya codificada según nature)
    // Detectar dirección: cost → q[0]>q[4], benefit → q[0]<q[4]
    const isCost = q[0] > q[4];

    if (isCost) {
      // Criterio cost: mayor raw = peor = q[0]
      // Peor que inaceptable: x > q[0]
      if (x >= q[0]) {
        const den = q[0] - q[1];
        if (Math.abs(den) < EPS) return alpha[0];
        // Pendiente negativa: más allá de q[0] → α cae por debajo de α[0]
        return alpha[0] - ((alpha[1] - alpha[0]) / den) * (x - q[0]);
      }
      // Interpolación entre tramos (q[k-1] > x >= q[k])
      for (let k = 1; k <= 4; k++) {
        if (x >= q[k]) {
          const den = q[k - 1] - q[k];
          if (Math.abs(den) < EPS) return (alpha[k - 1] + alpha[k]) / 2;
          return alpha[k - 1] + ((alpha[k] - alpha[k - 1]) / den) * (q[k - 1] - x);
        }
      }
      // Mejor que ideal: x < q[4]
      const den = q[3] - q[4];
      if (Math.abs(den) < EPS) return alpha[4];
      return alpha[4] + ((alpha[4] - alpha[3]) / den) * (q[4] - x);

    } else {
      // Criterio benefit: menor raw = peor = q[0]
      // Peor que inaceptable: x < q[0]
      if (x <= q[0]) {
        const den = q[1] - q[0];
        if (Math.abs(den) < EPS) return alpha[0];
        return alpha[0] - ((alpha[1] - alpha[0]) / den) * (q[0] - x);
      }
      // Interpolación entre tramos (q[k-1] <= x < q[k])
      for (let k = 1; k <= 4; k++) {
        if (x <= q[k]) {
          const den = q[k] - q[k - 1];
          if (Math.abs(den) < EPS) return (alpha[k - 1] + alpha[k]) / 2;
          return alpha[k - 1] + ((alpha[k] - alpha[k - 1]) / den) * (x - q[k - 1]);
        }
      }
      // Mejor que ideal: x > q[4]
      const den = q[4] - q[3];
      if (Math.abs(den) < EPS) return alpha[4];
      return alpha[4] + ((alpha[4] - alpha[3]) / den) * (x - q[4]);
    }
  }

  // ════════════════════════════════════════════════════════════
  // PESOS CRITIC (coherente con topsis_engine.js)
  //
  // Normalización Min-Max sobre raw X (no sobre X') para evitar
  // pérdida de varianza en criterios cost con inversión.
  // Pearson poblacional (divide por n, no n-1) sobre normData.
  // C_j = σ_j · Σ_{k≠j}(1 − r_jk),  W_j = C_j / Σ C_l
  // ════════════════════════════════════════════════════════════
  function _criticWeights(X) {
    const m = X.length;
    const n = CRITERIA.length;

    if (m < 2) {
      const w = 1 / n;
      const weights = {};
      const C = {};
      CRITERIA.forEach(c => { weights[c.label] = w; C[c.label] = null; });
      return { W: new Array(n).fill(w), weights, C };
    }

    // 1. Normalización Min-Max por columna (escala uniforme [0,1])
    const mins = new Array(n).fill(Infinity);
    const maxs = new Array(n).fill(-Infinity);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < m; i++) {
        if (X[i][j] < mins[j]) mins[j] = X[i][j];
        if (X[i][j] > maxs[j]) maxs[j] = X[i][j];
      }
    }

    const Xn = X.map(row =>
      row.map((val, j) => {
        const range = maxs[j] - mins[j];
        return Math.abs(range) < EPS ? 0 : (val - mins[j]) / range;
      })
    );

    // 2. Medias sobre Xn
    const means = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      means[j] = Xn.reduce((acc, row) => acc + row[j], 0) / m;
    }

    // 3. Desviaciones típicas poblacionales sobre Xn
    const stds = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      const variance = Xn.reduce((acc, row) => acc + Math.pow(row[j] - means[j], 2), 0) / m;
      stds[j] = Math.sqrt(variance);
    }

    // 4. Correlaciones de Pearson sobre Xn (clamp [-1, 1])
    const R = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      R[j][j] = 1;
      for (let k = j + 1; k < n; k++) {
        let num = 0, ssJ = 0, ssK = 0;
        for (let i = 0; i < m; i++) {
          const dj = Xn[i][j] - means[j];
          const dk = Xn[i][k] - means[k];
          num += dj * dk;
          ssJ += dj * dj;
          ssK += dk * dk;
        }
        const denom = Math.sqrt(ssJ * ssK);
        const r = Math.abs(denom) < EPS ? 0 : num / denom;
        R[j][k] = Math.max(-1, Math.min(1, r));
        R[k][j] = R[j][k];
      }
    }

    // 5. Información CRITIC C_j y pesos W_j
    const Craw = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      let sumDiv = 0;
      for (let k = 0; k < n; k++) {
        if (k !== j) sumDiv += (1 - R[j][k]);
      }
      Craw[j] = stds[j] * sumDiv;
    }

    const sumC = Craw.reduce((a, v) => a + v, 0);
    const W = Math.abs(sumC) < EPS
      ? new Array(n).fill(1 / n)
      : Craw.map(c => c / sumC);

    const weights = {};
    const C = {};
    CRITERIA.forEach((crit, j) => {
      weights[crit.label] = W[j];
      C[crit.label]       = Craw[j];
    });

    return { W, weights, C, stds, R, means };
  }

  // ════════════════════════════════════════════════════════════
  // PASOS 5-7 — Matriz de logro S, Leontief, Veto
  // ════════════════════════════════════════════════════════════

  /**
   * Calcula el vector de satisfacción parcial s_j para una alternativa.
   * @param {number[]} rawRow   [eco, amb, soc] valores brutos
   * @param {object}  thresholds  { eco:[q0..q4], amb:[q0..q4], soc:[q0..q4] }
   * @param {number[]} alpha    [α0..α4]
   * @returns {{ s_eco, s_amb, s_soc }}
   */
  function _achievementVector(rawRow, thresholds, alpha) {
    return {
      s_eco: _interpolate(rawRow[0], thresholds.eco, alpha),
      s_amb: _interpolate(rawRow[1], thresholds.amb, alpha),
      s_soc: _interpolate(rawRow[2], thresholds.soc, alpha)
    };
  }

  /**
   * Operador de Leontief: SS = min(s_eco, s_amb, s_soc)
   * El mínimo es el cuello de botella estructural del sistema.
   */
  function _leontief(s_eco, s_amb, s_soc) {
    return Math.min(s_eco, s_amb, s_soc);
  }

  /**
   * Identifica el pilar que genera el veto (el que tiene menor s_j).
   * Si hay empate, lista todos los que alcanzan el mínimo.
   */
  function _failingPillar(s_eco, s_amb, s_soc, ss) {
    const pairs = [
      { label: 'Economic', val: s_eco },
      { label: 'Environmental', val: s_amb },
      { label: 'Social',    val: s_soc }
    ];
    const failing = pairs.filter(p => Math.abs(p.val - ss) < EPS);
    return failing.map(p => p.label).join(' + ');
  }

  // ════════════════════════════════════════════════════════════
  // PASO 8 — Ensamblado del ranking con metadatos de transparencia
  // ════════════════════════════════════════════════════════════
  function _buildRanking(data, labels, tipos, X, thresholds, alpha, lineaRoja) {
    const rows = labels.map((nombre, i) => {
      const rawRow = X[i];
      const { s_eco, s_amb, s_soc } = _achievementVector(rawRow, thresholds, alpha);
      const ss            = _leontief(s_eco, s_amb, s_soc);
      const vetada        = ss < lineaRoja;
      const pilar_fallido = vetada ? _failingPillar(s_eco, s_amb, s_soc, ss) : 'Ninguno';

      return {
        nombre,
        tipo       : tipos[i],
        // Valores brutos originales (columnas de transparencia)
        eco        : rawRow[0],
        amb        : rawRow[1],
        soc        : rawRow[2],
        // Alfas parciales (logros por criterio)
        s_eco,
        s_amb,
        s_soc,
        // Alfa final (operador Leontief)
        ss,
        // Veredicto
        vetada,
        pilar_fallido,
        veredicto  : vetada ? `VETADA [Pilar: ${pilar_fallido}]` : 'VIABLE'
      };
    });

    // Ordenar por SS descendente. Alternativas vetadas al final.
    rows.sort((a, b) => {
      if (a.vetada !== b.vetada) return a.vetada ? 1 : -1;
      return b.ss - a.ss;
    });

    return rows.map((r, idx) => ({ rank: idx + 1, accion: r.nombre, ...r }));
  }

  // ════════════════════════════════════════════════════════════
  // API PÚBLICA — MRPEngine.run(data, opts)
  // ════════════════════════════════════════════════════════════
  /**
   * Ejecuta el pipeline completo CRITIC + MRP-Leontief.
   *
   * @param {Array<{nombre:string, tipo:string, eco:number, amb:number, soc:number}>} data
   *   Array de alternativas aplanadas (salida de SonyaConnector.getAlternatives(ufId))
   *
   * @param {object} [opts]
   * @param {number[]} [opts.alpha]
   *   Escala de satisfacción [α0..α4]. Default: [0, 1, 2.5, 3, 4]
   * @param {object}  [opts.qCustom]
   * @param {number}  [opts.lineaRoja]
   *   Umbral de veto Leontief. Default: 1.0 (= α1 de la escala semántica)
   *
   * @returns {{
   *   engine:     string,
   *   uf_count:   number,
   *   alpha:      number[],
   *   lineaRoja:  number,
   *   pesos:      { Economic:number, Environmental:number, Social:number },
   *   critic_C:   { Economic:number, Environmental:number, Social:number },
   *   std:        { eco:number, amb:number, soc:number },
   *   pearson:    number[][],
   *   umbrales:   { eco:number[], amb:number[], soc:number[] },
   *   ranking:    Array<RankRow>
   * }}
   */
  function run(data, opts = {}) {
    const alpha     = opts.alpha     ?? ALPHA_DEFAULT;
    const lineaRoja = opts.lineaRoja ?? LR_DEFAULT;
    const qCustomRaw = opts.qCustom ?? null;

    if (!Array.isArray(data) || data.length < 2) {
      throw new Error('[MRPEngine] Se requieren al menos 2 alternativas.');
    }
    if (!Array.isArray(alpha) || alpha.length !== 5) {
      throw new Error('[MRPEngine] alpha debe ser un array de exactamente 5 valores [α0..α4].');
    }

    // ── 1. Matriz raw ────────────────────────────────────────
    const { X, labels, tipos } = _buildMatrix(data);

    // ── 2. Umbrales físicos ──────────────────────────────────
    let thresholds;
    if (qCustomRaw && typeof qCustomRaw === 'object' && Object.keys(qCustomRaw).length > 0) {
      thresholds = _normalizeCustomQ(qCustomRaw);
      // Validar que estén los tres criterios
      CRITERIA.forEach(c => {
        if (!Array.isArray(thresholds[c.key]) || thresholds[c.key].length !== 5) {
          throw new Error(`[MRPEngine] qCustom["${c.key}"] debe ser un array de 5 valores.`);
        }
      });
    } else {
      thresholds = _computeThresholds(X);
    }

    // ── CRITIC ───────────────────────────────────────────────
    const { W, weights, C, stds, R } = _criticWeights(X);

    // Construir objetos legibles para UI
    const stdObj = {};
    CRITERIA.forEach((c, j) => { stdObj[c.key] = stds ? stds[j] : null; });

    // ── 3-7. Logro + Leontief + Veto ─────────────────────────
    const ranking = _buildRanking(data, labels, tipos, X, thresholds, alpha, lineaRoja);

    // ── Formato de umbrales para UI (array[5] raw por criterio) ─
    const umbralUI = {};
    CRITERIA.forEach(c => {
      umbralUI[c.label] = thresholds[c.key];
    });

    return {
      engine    : 'MRP-Leontief',
      uf_count  : data.length,
      alpha,
      lineaRoja,
      // Pesos CRITIC (discriminación, no participan en Leontief)
      pesos     : weights,
      critic_C  : C,
      std       : stdObj,
      pearson   : R ?? null,
      // Umbrales físicos en formato UI (por label de criterio)
      umbrales  : umbralUI,
      // Umbrales internos (por key de criterio, para auditoría)
      umbrales_raw: thresholds,
      // Ranking con transparencia completa
      ranking
    };
  }

  // ─── Exponer constantes para que logic_connector.js las use ──
  return {
    run,
    ALPHA_DEFAULT,
    LR_DEFAULT,
    CRITERIA
  };

})();

// Registro global explícito
window.MRPEngine = MRPEngine;
