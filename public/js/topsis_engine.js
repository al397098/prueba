/**
 * ============================================================
 * SONYA Suite Analítica v3.0 — topsis_engine.js
 * Motor CRITIC + TOPSIS con métrica de Chebyshev (L∞)
 * Sostenibilidad Fuerte: no-compensatorio, minimax.
 *
 * PIPELINE (10 pasos, conforme a presentacion_topsis.html):
 *  1. Matriz de decisión X [m × n]
 *  2. Normalización lineal por columna  x'_ij = (max - x_ij) / (max - min)
 *     → criterios cost:    (max - x) / (max - min)  → mayor x' = mejor
 *     → criterios benefit: (x - min) / (max - min)  → mayor x' = mejor
 *  3. Desviación típica σ_j (poblacional) sobre X'
 *  4. Correlaciones de Pearson r_jk sobre X'
 *  5. Pesos CRITIC:  C_j = σ_j · Σ(1 − r_jk),  W_j = C_j / Σ C_l
 *  6. Matriz ponderada V:  v_ij = x'_ij · W_j
 *  7. PIS A⁺ = max_i(v_ij) por columna   [ya en espacio normalizado]
 *     NIS A⁻ = min_i(v_ij) por columna
 *  8. Distancias Chebyshev (L∞, NO Euclídea):
 *       D⁺_i = max_j |v_ij − v_j⁺|
 *       D⁻_i = min_j |v_ij − v_j⁻|
 *  9. CC_i = D⁻_i / (D⁺_i + D⁻_i)  ∈ [0, 1]
 * 10. Ranking por CC descendente. Veredicto según threshold.
 *
 * CRITERIOS SOPORTADOS (leídos de _meta.criteria en database.json
 * o inferidos desde la propiedad `nature` de cada campo):
 *   nature: 'cost'    → Eco, Amb  (minimizar)
 *   nature: 'benefit' → Soc       (maximizar)
 *
 * EXPOSICIÓN GLOBAL:
 *   window.TOPSISEngine.run(data, opts) → resultado completo
 *
 * DEPENDENCIA: ninguna (vanilla JS ES6+)
 * ============================================================
 */

const TOPSISEngine = (() => {

  // ─── Definición de criterios ─────────────────────────────────
  // Cada criterio tiene:
  //   key     : nombre del campo en el objeto alternativa
  //   label   : etiqueta para UI/debug
  //   nature  : 'cost' | 'benefit'
  const CRITERIA = [
    { key: 'eco', label: 'Económico', nature: 'cost'    },
    { key: 'amb', label: 'Ambiental', nature: 'cost'    },
    { key: 'soc', label: 'Social',    nature: 'cost' }
  ];

  const EPS = 1e-10; // Tolerancia numérica para denominadores nulos

  // ════════════════════════════════════════════════════════════
  // PASO 1 — Extracción de la matriz de decisión raw
  // ════════════════════════════════════════════════════════════
  // data: Array<{ nombre, tipo, eco, amb, soc }>
  // Retorna: { X: number[][], labels: string[], tipos: string[] }
  function _buildMatrix(data) {
    return {
      X      : data.map(d => CRITERIA.map(c => parseFloat(d[c.key]) || 0)),
      labels : data.map(d => d.nombre),
      tipos  : data.map(d => d.tipo ?? 'EX-POST')
    };
  }

  // ════════════════════════════════════════════════════════════
  // PASO 2 — Normalización lineal por columna
  // cost:    x'_ij = (max_j − x_ij) / (max_j − min_j)   [1=mejor=mínimo raw]
  // benefit: x'_ij = (x_ij − min_j) / (max_j − min_j)   [1=mejor=máximo raw]
  // Si rango = 0 (columna constante) → x' = 0 (criterio no discrimina)
  // ════════════════════════════════════════════════════════════
  function _normalize(X) {
    const m = X.length;
    const n = CRITERIA.length;
    const Xp = Array.from({ length: m }, () => new Array(n).fill(0));

    for (let j = 0; j < n; j++) {
      const col    = X.map(row => row[j]);
      const minVal = Math.min(...col);
      const maxVal = Math.max(...col);
      const range  = maxVal - minVal;

      for (let i = 0; i < m; i++) {
        if (Math.abs(range) < EPS) {
          Xp[i][j] = 0;
        } else if (CRITERIA[j].nature === 'cost') {
          Xp[i][j] = (maxVal - X[i][j]) / range;
        } else { // benefit
          Xp[i][j] = (X[i][j] - minVal) / range;
        }
      }
    }

    return Xp;
  }

  // ════════════════════════════════════════════════════════════
  // PASO 3 — Desviación típica poblacional σ_j sobre X'
  // σ_j = sqrt( (1/m) · Σ(x'_ij − mean_j)² )
  // ════════════════════════════════════════════════════════════
  function _stdDev(Xp) {
    const m = Xp.length;
    const n = CRITERIA.length;
    const means = new Array(n).fill(0);
    const stds  = new Array(n).fill(0);

    // Medias
    for (let j = 0; j < n; j++) {
      means[j] = Xp.reduce((acc, row) => acc + row[j], 0) / m;
    }

    // Desviaciones típicas (poblacional: divide por m, no m-1)
    for (let j = 0; j < n; j++) {
      const variance = Xp.reduce((acc, row) => acc + Math.pow(row[j] - means[j], 2), 0) / m;
      stds[j] = Math.sqrt(variance);
    }

    return { means, stds };
  }

  // ════════════════════════════════════════════════════════════
  // PASO 4 — Correlaciones de Pearson r_jk sobre X'
  // r_jk = Σ(x'_ij − mean_j)(x'_ik − mean_k) /
  //         sqrt[ Σ(x'_ij − mean_j)² · Σ(x'_ik − mean_k)² ]
  // r_jj = 1  por definición
  // Clamp a [-1, 1] para errores de punto flotante
  // ════════════════════════════════════════════════════════════
  function _pearson(Xp, means) {
    const m = Xp.length;
    const n = CRITERIA.length;
    // Matriz n×n de correlaciones
    const R = Array.from({ length: n }, () => new Array(n).fill(0));

    for (let j = 0; j < n; j++) {
      R[j][j] = 1;
      for (let k = j + 1; k < n; k++) {
        let num  = 0, ssJ = 0, ssK = 0;
        for (let i = 0; i < m; i++) {
          const dj = Xp[i][j] - means[j];
          const dk = Xp[i][k] - means[k];
          num  += dj * dk;
          ssJ  += dj * dj;
          ssK  += dk * dk;
        }
        const denom = Math.sqrt(ssJ * ssK);
        const r = Math.abs(denom) < EPS ? 0 : num / denom;
        R[j][k] = Math.max(-1, Math.min(1, r));
        R[k][j] = R[j][k]; // simétrica
      }
    }

    return R;
  }

  // ════════════════════════════════════════════════════════════
  // PASO 5 — Pesos CRITIC
  // C_j = σ_j · Σ_{k≠j}(1 − r_jk)
  // W_j = C_j / Σ C_l
  // Si Σ C_l = 0 (todos constantes) → pesos iguales 1/n
  // ════════════════════════════════════════════════════════════
  function _criticWeights(stds, R) {
    const n = CRITERIA.length;
    const C = new Array(n).fill(0);

    for (let j = 0; j < n; j++) {
      let sumDivergence = 0;
      for (let k = 0; k < n; k++) {
        if (k !== j) sumDivergence += (1 - R[j][k]);
      }
      C[j] = stds[j] * sumDivergence;
    }

    const sumC = C.reduce((a, v) => a + v, 0);
    const W = sumC < EPS
      ? new Array(n).fill(1 / n)                   // Fallback: igual ponderación
      : C.map(c => c / sumC);

    // Construir objeto con claves legibles para UI
    const weights = {};
    CRITERIA.forEach((c, j) => { weights[c.label] = W[j]; });

    return { W, weights, C };
  }

  // ════════════════════════════════════════════════════════════
  // PASO 6 — Matriz ponderada V
  // v_ij = x'_ij · W_j
  // ════════════════════════════════════════════════════════════
  function _weightedMatrix(Xp, W) {
    return Xp.map(row => row.map((val, j) => val * W[j]));
  }

  // ════════════════════════════════════════════════════════════
  // PASO 7 — Soluciones ideales en espacio V
  // PIS A⁺ = max_i(v_ij) por columna   [mayor v = mejor]
  // NIS A⁻ = min_i(v_ij) por columna   [menor v = peor]
  // Válido para todos los criterios tras normalización (mayor = mejor)
  // ════════════════════════════════════════════════════════════
  function _idealSolutions(V) {
    const m = V.length;
    const n = CRITERIA.length;
    const pis = new Array(n).fill(-Infinity);
    const nis = new Array(n).fill(+Infinity);

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < m; i++) {
        if (V[i][j] > pis[j]) pis[j] = V[i][j];
        if (V[i][j] < nis[j]) nis[j] = V[i][j];
      }
    }

    // Construir objeto con claves legibles para debug/transparencia
    const pisObj = {}, nisObj = {};
    CRITERIA.forEach((c, j) => { pisObj[c.key] = pis[j]; nisObj[c.key] = nis[j]; });

    return { pis, nis, pisObj, nisObj };
  }

  // ════════════════════════════════════════════════════════════
  // PASO 8 — Distancias Chebyshev (L∞) — NO Euclídea
  //
  // D⁺_i = max_j | v_ij − v_j⁺ |   ← peor brecha respecto al ideal
  // D⁻_i = min_j | v_ij − v_j⁻ |   ← menor brecha respecto al anti-ideal
  //
  // El uso de max() en D⁺ garantiza Sostenibilidad Fuerte:
  // el criterio más rezagado determina la posición, sin compensación.
  // El uso de min() en D⁻ evita que un solo acierto excepcional
  // infle artificialmente la distancia al anti-ideal.
  // ════════════════════════════════════════════════════════════
  function _chebyshevDistances(V, pis, nis) {
    const m = V.length;
    const n = CRITERIA.length;
    const dPlus  = new Array(m).fill(0);
    const dMinus = new Array(m).fill(0);
    // Para depuración: brecha por criterio
    const gapsPlus  = Array.from({ length: m }, () => new Array(n).fill(0));
    const gapsMinus = Array.from({ length: m }, () => new Array(n).fill(0));

    for (let i = 0; i < m; i++) {
      let maxGap = -Infinity;
      let minGap = +Infinity;

      for (let j = 0; j < n; j++) {
        const gp = Math.abs(V[i][j] - pis[j]);
        const gn = Math.abs(V[i][j] - nis[j]);
        gapsPlus[i][j]  = gp;
        gapsMinus[i][j] = gn;
        if (gp > maxGap) maxGap = gp;
        if (gn < minGap) minGap = gn;
      }

      dPlus[i]  = maxGap;
      dMinus[i] = minGap;
    }

    return { dPlus, dMinus, gapsPlus, gapsMinus };
  }

  // ════════════════════════════════════════════════════════════
  // PASO 9 — Coeficiente de Proximidad Relativa CC*
  // CC_i = D⁻_i / (D⁺_i + D⁻_i)   ∈ [0, 1]
  // Caso degenerado D⁺ = D⁻ = 0 (alternativa idéntica al PIS y NIS): CC = 0
  // ════════════════════════════════════════════════════════════
  function _closenessCoefficient(dPlus, dMinus) {
    return dPlus.map((dp, i) => {
      const dm  = dMinus[i];
      const den = dp + dm;
      return Math.abs(den) < EPS ? 0 : dm / den;
    });
  }

  // ════════════════════════════════════════════════════════════
  // PASO 10 — Ensamblado del ranking con metadatos de transparencia
  // ════════════════════════════════════════════════════════════
  function _buildRanking(data, labels, tipos, X, Xp, V, cc, dPlus, dMinus, gapsPlus, threshold) {
    const rows = labels.map((nombre, i) => ({
      nombre,
      tipo  : tipos[i],
      // Valores brutos originales (transparencia requerida)
      eco   : X[i][0],
      amb   : X[i][1],
      soc   : X[i][2],
      // Valores normalizados (para auditoría matemática)
      xp_eco: Xp[i][0],
      xp_amb: Xp[i][1],
      xp_soc: Xp[i][2],
      // Valores ponderados V (para auditoría matemática)
      v_eco : V[i][0],
      v_amb : V[i][1],
      v_soc : V[i][2],
      // Brechas Chebyshev por criterio (para auditoría)
      gap_plus_eco: gapsPlus[i][0],
      gap_plus_amb: gapsPlus[i][1],
      gap_plus_soc: gapsPlus[i][2],
      // Distancias L∞
      d_plus : dPlus[i],
      d_minus: dMinus[i],
      // Coeficiente final
      cc     : cc[i],
      // Veredicto
      veredicto: cc[i] >= threshold ? 'APROBADA' : 'DESCARTADA'
    }));

    // Ordenar por CC descendente (mayor CC = mejor)
    rows.sort((a, b) => b.cc - a.cc);

    // Añadir posición ordinal tras ordenar
    return rows.map((r, idx) => ({ rank: idx + 1, accion: r.nombre, ...r }));
  }

  // ════════════════════════════════════════════════════════════
  // API PÚBLICA — TOPSISEngine.run(data, opts)
  // ════════════════════════════════════════════════════════════
  /**
   * Ejecuta el pipeline completo CRITIC + TOPSIS-Chebyshev.
   *
   * @param {Array<{nombre:string, tipo:string, eco:number, amb:number, soc:number}>} data
   *   Array de alternativas aplanadas (salida de SonyaConnector.getAlternatives(ufId))
   *
   * @param {object} [opts]
   * @param {number}  [opts.threshold=0.5]
   *   Umbral CC para veredicto APROBADA/DESCARTADA
   * @param {{Económico?:number, Ambiental?:number, Social?:number}} [opts.customWeights=null]
   *   Si se proporcionan, bypasa CRITIC y usa estos pesos (deben sumar ~1).
   *   Las claves son los labels de CRITERIA.
   *
   * @returns {{
   *   engine:    string,
   *   uf_count:  number,
   *   threshold: number,
   *   pesos:     { Económico:number, Ambiental:number, Social:number },
   *   critic_C:  { Económico:number, Ambiental:number, Social:number },
   *   std:       { eco:number, amb:number, soc:number },
   *   pearson:   number[][],
   *   pis:       { eco:number, amb:number, soc:number },
   *   nis:       { eco:number, amb:number, soc:number },
   *   ranking:   Array<RankRow>
   * }}
   */
  function run(data, opts = {}) {
    const threshold     = opts.threshold     ?? 0.5;
    const customWeights = opts.customWeights ?? null;

    if (!Array.isArray(data) || data.length < 2) {
      throw new Error('[TOPSISEngine] Se requieren al menos 2 alternativas.');
    }

    const n = CRITERIA.length;

    // ── 1. Matriz de decisión ────────────────────────────────
    const { X, labels, tipos } = _buildMatrix(data);

    // ── 2. Normalización lineal ──────────────────────────────
    const Xp = _normalize(X);

    // ── 3. Estadísticos ─────────────────────────────────────
    const { means, stds } = _stdDev(Xp);

    // ── 4. Pearson ───────────────────────────────────────────
    const R = _pearson(Xp, means);

    // ── 5. Pesos CRITIC (o custom) ───────────────────────────
    let W, weights, criticC;
    if (customWeights) {
      // Normalizar a suma 1 por si acaso
      const sum = CRITERIA.reduce((acc, c) => acc + (customWeights[c.label] ?? 0), 0);
      W = CRITERIA.map(c => (customWeights[c.label] ?? 0) / (Math.abs(sum) < EPS ? 1 : sum));
      weights = {};
      CRITERIA.forEach((c, j) => { weights[c.label] = W[j]; });
      criticC = {};
      CRITERIA.forEach((c, j) => { criticC[c.label] = null; }); // No aplica
    } else {
      const result = _criticWeights(stds, R);
      W       = result.W;
      weights = result.weights;
      criticC = {};
      CRITERIA.forEach((c, j) => { criticC[c.label] = result.C[j]; });
    }

    // ── 6. Matriz ponderada V ────────────────────────────────
    const V = _weightedMatrix(Xp, W);

    // ── 7. PIS / NIS ─────────────────────────────────────────
    const { pis, nis, pisObj, nisObj } = _idealSolutions(V);

    // ── 8. Distancias Chebyshev (L∞) ────────────────────────
    const { dPlus, dMinus, gapsPlus, gapsMinus } = _chebyshevDistances(V, pis, nis);

    // ── 9. Coeficiente CC ────────────────────────────────────
    const cc = _closenessCoefficient(dPlus, dMinus);

    // ── 10. Ranking ──────────────────────────────────────────
    const ranking = _buildRanking(data, labels, tipos, X, Xp, V, cc, dPlus, dMinus, gapsPlus, threshold);

    // ── Metadatos de desviación típica legibles ───────────────
    const stdObj = {};
    CRITERIA.forEach((c, j) => { stdObj[c.key] = stds[j]; });

    return {
      engine   : 'TOPSIS-Chebyshev-L∞',
      uf_count : data.length,
      threshold,
      // Pesos CRITIC finales
      pesos    : weights,
      // Información de construcción de pesos (para tab Matemáticas)
      critic_C : criticC,
      std      : stdObj,
      pearson  : R,
      means    : (() => { const o = {}; CRITERIA.forEach((c, j) => { o[c.key] = means[j]; }); return o; })(),
      // Soluciones ideales en espacio ponderado V
      pis      : pisObj,
      nis      : nisObj,
      // Ranking completo con transparencia de impactos brutos + intermedios
      ranking
    };
  }

  // ── Exponer criterios para que los HTMLs puedan acceder ──────
  return { run, CRITERIA };

})();

// Registro global explícito
window.TOPSISEngine = TOPSISEngine;
