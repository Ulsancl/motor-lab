import { assertValidState, instantSnapshot, MOTOR_CONSTANTS_SI } from './model.js';
import { GEOMETRY_SI, sampleCommutation, TAU } from './geometry.js';
import { motorBearingKinematics } from './mechanical-geometry.js';

const zero = value => Object.is(value, -0) ? 0 : value;
const { resistanceOhm: R, inductanceH: L, torqueConstantNmPerA: Kt,
  backEmfConstantVsPerRad: Ke, inertiaKgM2: J, frictionCoefficient: B } = MOTOR_CONSTANTS_SI;

/** Read-only observations of the existing average DC model, in SI units.
 * A supplied snapshot must be instantSnapshot(state) for this same state.
 * Contact areas are curved geometric overlaps, not solved electrical contacts.
 */
export function motorDetail(state, snapshot = instantSnapshot(state)) {
  assertValidState(state);
  const { currentA: i, omegaRadS: w, settings: { voltageV: voltage, loadCoefficient: load }, locked } = state;
  const resistiveV = zero(R * i), backEmfV = zero(Ke * w);
  const inductiveV = zero(voltage - resistiveV - backEmfV);
  const currentRateAps = zero(inductiveV / L);
  const electromagneticNm = zero(Kt * i), frictionNm = zero(-B * w), loadNm = zero(-load * w);
  const constraintNm = locked ? zero(-electromagneticNm) : 0;
  const netNm = zero(electromagneticNm + frictionNm + loadNm + constraintNm);
  const accelerationRadS2 = locked ? 0 : zero((Kt * i - (B + load) * w) / J);
  const magneticStorageW = zero(L * i * currentRateAps), kineticStorageW = zero(J * w * accelerationRadS2);
  const { supply, copper, friction, load: loadPower, electromagnetic } = snapshot.powerW;
  const steadyOmega = locked ? 0 : Kt * voltage / (R * (B + load) + Kt * Ke);
  const steadyCurrent = locked ? voltage / R : (B + load) * voltage / (R * (B + load) + Kt * Ke);
  const commutation = sampleCommutation(state.angleRad);
  const brush = contacts => {
    const entries = contacts.map(({ segmentId, overlapRad }) => ({
      segmentId, overlapRad, areaM2: GEOMETRY_SI.commutatorRadius * overlapRad * GEOMETRY_SI.brushWidthX,
    }));
    return { contacts: entries, copperAreaM2: entries.reduce((sum, contact) => sum + contact.areaM2, 0) };
  };
  const { magnetic, kinetic, total } = snapshot.storedEnergyJ;
  const bearingMotion = motorBearingKinematics({ omegaRadS: w });
  return {
    timeS: state.timeS, angleRad: state.angleRad, currentA: i, omegaRadS: w, rpm: snapshot.rpm, locked,
    electrical: {
      sourceV: voltage, resistiveV, backEmfV, inductiveV, currentRateAps,
      rlTimeConstantS: L / R,
      residualV: zero(voltage - resistiveV - backEmfV - L * currentRateAps),
    },
    mechanical: {
      electromagneticNm, frictionNm, loadNm, constraintNm, netNm, accelerationRadS2,
      residualNm: zero(netNm - J * accelerationRadS2),
    },
    power: {
      supplyW: supply, copperW: copper, frictionW: friction, loadW: loadPower,
      electromagneticW: electromagnetic, magneticStorageW, kineticStorageW,
      residualW: zero(supply - copper - friction - loadPower - magneticStorageW - kineticStorageW),
      electricalResidualW: zero(supply - copper - electromagnetic - magneticStorageW),
      mechanicalResidualW: zero(electromagnetic - friction - loadPower - kineticStorageW),
    },
    steady: {
      currentA: zero(steadyCurrent), omegaRadS: zero(steadyOmega), rpm: zero(steadyOmega * 60 / TAU),
      backEmfV: zero(Ke * steadyOmega), torqueNm: zero(Kt * steadyCurrent),
      supplyW: zero(voltage * steadyCurrent), copperW: R * steadyCurrent ** 2,
      frictionW: B * steadyOmega ** 2, loadW: load * steadyOmega ** 2,
    },
    storedEnergyJ: { magnetic, kinetic, total },
    energyJ: { ...snapshot.energyJ },
    balance: { energyResidualJ: zero(snapshot.energyJ.supply - snapshot.energyJ.copper - snapshot.energyJ.friction - snapshot.energyJ.load - total) },
    // Saved motor phase contains no turn count. Bearing phases belong to the
    // scene's unwrapped visual history, so only instantaneous rates are exposed.
    bearing: Object.fromEntries(['innerRpm', 'outerRpm', 'cageRpm', 'ballWorldRpm'].map(key => [key, zero(bearingMotion[key])])),
    contact: {
      surfaceVelocityMps: zero(GEOMETRY_SI.commutatorRadius * w),
      passesPerBrushHz: GEOMETRY_SI.segmentCentersRad.length * Math.abs(w) / TAU,
      nominalAreaM2: GEOMETRY_SI.commutatorRadius * GEOMETRY_SI.brushArcRad * GEOMETRY_SI.brushWidthX,
      brushArcRad: GEOMETRY_SI.brushArcRad, segmentGapRad: GEOMETRY_SI.segmentGapRad,
      positive: brush(commutation.positive), negative: brush(commutation.negative),
      bridgedCoils: [...commutation.bridgedCoils],
    },
  };
}
