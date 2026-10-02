import { motorDetail } from './detail-model.js';
import { GEOMETRY_SI as G } from './geometry.js';
import { MOTOR_CONSTANTS_SI as M } from './model.js';
import { BEARING_DETAIL } from './mechanical-geometry.js';

const degrees = radians => radians * 180 / Math.PI;
const fact = (label, value, unit = '', digits = 2) => ({ label, value, unit, digits });
const segmentName = id => id.replace('segment-', 'S');
const contactsName = contacts => contacts.map(contact => segmentName(contact.segmentId)).join(' · ');
const averageNote = 'R·L·전류·손실은 전체 전기자의 평균 등가값입니다. A/B/C의 가지 전류나 권선별 발열·온도는 계산하지 않습니다.';
const contactNote = '면적은 정류자 곡면에서 구리와 브러시가 겹치는 기하값입니다. 접촉 압력·저항·스파크·코일별 전류를 계산한 값이 아닙니다. 통과 빈도는 현재 속력을 유지할 때 브러시 하나를 지나는 구리 편의 빈도입니다.';
const torqueNote = '전자기·마찰·부하 토크의 부호는 +X 회전을 기준으로 합니다. 관성은 모터와 부하의 등가 합이며, 개별 축·커플링의 비틀림이나 전달 토크 분배는 계산하지 않습니다.';
const steadyNote = '평형 참조는 현재 전압·부하를 계속 유지할 때의 최종값입니다. 현재 전류·속도·저장 에너지를 초기화하거나 도달 시간을 예측하지 않습니다.';

/** Component observations derived without changing simulation or project data. */
export function describeMotorDetail(partId, state, snapshot) {
  const d = motorDetail(state, snapshot), e = d.electrical, m = d.mechanical, p = d.power, c = d.contact;
  const current = () => fact('평균 단자 전류 · +단자 유입 +', d.currentA, 'A', 3);
  const rpm = () => fact('현재 회전수', d.rpm, 'rpm', 1);
  const surface = () => fact('정류자 표면 속도 · +X 회전 +', c.surfaceVelocityMps, 'm/s', 3);
  const frequency = () => fact('브러시당 편 통과 빈도', c.passesPerBrushHz, 'Hz', 2);
  const branch = partId.endsWith('negative') ? c.negative : c.positive;

  if (partId.startsWith('brush-positive') || partId.startsWith('brush-negative')) return {
    facts: [fact('현재 접촉 구리 편', contactsName(branch.contacts)),
      fact('구리와 겹친 각폭 합', degrees(branch.contacts.reduce((sum, row) => sum + row.overlapRad, 0)), '°', 2),
      fact('구리 접촉 기하 면적', branch.copperAreaM2 * 1e6, 'mm²', 2), surface(), frequency(), current()],
    note: contactNote + ' 평균 단자 전류의 + 방향은 +브러시로 들어오는 방향입니다.',
  };
  if (partId.startsWith('brush-holder-') || partId.startsWith('brush-spring-')) return {
    facts: [fact('지지하는 브러시', partId.endsWith('negative') ? '− 단자 브러시' : '+ 단자 브러시'),
      fact('현재 접촉 구리 편', contactsName(branch.contacts)),
      fact('구리 접촉 기하 면적', branch.copperAreaM2 * 1e6, 'mm²', 2), surface(),
      fact('스프링 힘·마모·접촉 압력', '계산하지 않음')],
    note: '홀더와 스프링은 고정된 브러시를 지지하는 대표 구조입니다. 스프링 상수·예압·마모 상태는 평균 모형에 없습니다. ' + contactNote,
  };
  if (partId.startsWith('segment-')) {
    const overlap = branch => branch.contacts.find(row => row.segmentId === partId)?.overlapRad ?? 0;
    const positive = overlap(c.positive), negative = overlap(c.negative);
    return { facts: [fact('구리 편 각폭', degrees(G.segmentArcRad), '°', 1), fact('편 사이 절연 각폭', degrees(G.segmentGapRad), '°', 1),
      fact('+ 브러시와 겹친 각폭', degrees(positive), '°', 2), fact('− 브러시와 겹친 각폭', degrees(negative), '°', 2),
      fact('구리 접촉 기하 면적', G.commutatorRadius * G.brushWidthX * (positive + negative) * 1e6, 'mm²', 2), surface()],
    note: contactNote + ' 접촉 색은 연결 단자를 나타내며 회생 중 전류 부호와는 별개입니다.' };
  }
  if (partId === 'commutator-hub') return {
    facts: [fact('구리 편 개수', G.segmentCentersRad.length, '개', 0), fact('정류자 외경', G.commutatorRadius * 2000, 'mm', 1),
      fact('편 사이 절연 각폭', degrees(G.segmentGapRad), '°', 1), fact('브러시 접촉 각폭', degrees(G.brushArcRad), '°', 1), surface(), frequency()],
    note: '절연 허브와 세 구리 편은 축과 함께 회전합니다. 두 편 동시 접촉은 기하로만 계산하며 평균 전류의 정류 맥동이나 단락 전류를 추가하지 않습니다.',
  };
  if (partId.startsWith('coil-')) {
    const coil = G.coils.find(coil => coil.id === partId);
    if (coil) return { facts: [fact('권선의 연결 편', `${segmentName(coil.from)} → ${segmentName(coil.to)}`), current(),
      fact('전체 전기자 저항', M.resistanceOhm, 'Ω', 2), fact('전체 전기자 인덕턴스', M.inductanceH * 1000, 'mH', 2),
      fact('전체 전기자 구리 손실', p.copperW, 'W', 3), fact('전체 자기 저장 에너지', d.storedEnergyJ.magnetic * 1000, 'mJ', 3)], note: averageNote };
  }
  if (partId === 'slot-insulation') return {
    facts: [fact('지지하는 권선', 'A · B · C'), fact('전체 전기자 저항 전압', e.resistiveV, 'V', 3),
      fact('전체 전기자 구리 손실', p.copperW, 'W', 3), fact('절연 저항·내전압·온도', '계산하지 않음')],
    note: '표시한 저항 전압과 구리 손실은 권선 전체의 평균값이며 절연재의 손실이 아닙니다. 절연 두께로 전기 안전성이나 내전압을 판정하지 않습니다.',
  };
  if (partId === 'magnet-n' || partId === 'magnet-s') return {
    facts: [fact('평균 역기전력', e.backEmfV, 'V', 3),
      fact('역기전력 상수', M.backEmfConstantVsPerRad, 'V·s/rad', 3), fact('평균 토크 상수', M.torqueConstantNmPerA, 'N·m/A', 3),
      rpm(), fact('회전자 외형 한계와 공극', (G.magnetInnerRadius - G.windingOuterRadius) * 1000, 'mm', 2), fact('자속 밀도·자기 포화', '계산하지 않음')],
    note: '공극은 공유 기하의 회전자 외형 한계와 자석 안쪽 사이 거리입니다. 모터 상수는 고정된 예시값이며 자석 크기·공극에서 계산하지 않습니다. 자기력선은 방향 도식입니다.',
  };
  if (partId === 'armature-core') return {
    facts: [rpm(), fact('현재 각가속도', m.accelerationRadS2, 'rad/s²', 2), fact('평균 전자기 토크', m.electromagneticNm * 1000, 'mN·m', 2),
      fact('전체 회전 저장 에너지', d.storedEnergyJ.kinetic, 'J', 4), fact('회전 저장 에너지 변화율', p.kineticStorageW, 'W', 3),
      fact('같은 조건의 평형 회전수', d.steady.rpm, 'rpm', 1)],
    note: '회전 저장량은 철심만의 관성이 아닌 모터와 부하의 등가 관성에서 구합니다. 적층 형상이 철손·코깅·자기 포화를 계산하지는 않습니다. ' + steadyNote,
  };
  if (partId === 'shaft' || partId === 'coupling') return {
    facts: [rpm(), fact('현재 각가속도', m.accelerationRadS2, 'rad/s²', 2), fact('평균 전자기 토크', m.electromagneticNm * 1000, 'mN·m', 2),
      fact('점성 마찰 토크 · 부호 포함', m.frictionNm * 1000, 'mN·m', 2), fact('외부 부하 토크 · 부호 포함', m.loadNm * 1000, 'mN·m', 2),
      fact('회전 가속에 남는 토크', m.netNm * 1000, 'mN·m', 2)], note: torqueNote + (d.locked ? ' 축 고정 중에는 구속반력이 전자기 토크를 상쇄합니다.' : ''),
  };
  if (partId === 'load-rotor' || partId === 'load-housing') return {
    facts: [fact('적용 부하 계수', state.settings.loadCoefficient * 1000, 'mN·m·s/rad', 3), rpm(),
      fact('외부 부하 토크 · 부호 포함', m.loadNm * 1000, 'mN·m', 2), fact('부하 흡수 동력', p.loadW, 'W', 3),
      fact('누적 부하 흡수 에너지', d.energyJ.load, 'J', 4), fact('같은 조건의 평형 회전수', d.steady.rpm, 'rpm', 1)],
    note: '부하는 속도에 비례하는 이상 저항입니다. 부하 100%는 계수 0.001 N·m·s/rad를 뜻하며 모터 정격의 비율이 아닙니다. 흡수 에너지로 온도를 계산하지 않습니다. ' + steadyNote,
  };
  if (partId.startsWith('bearing-')) return {
    facts: [fact('내륜 회전수', d.bearing.innerRpm, 'rpm', 1), fact('외륜 회전수', d.bearing.outerRpm, 'rpm', 1),
      fact('케이지 공전 회전수', d.bearing.cageRpm, 'rpm', 1), fact('볼 자전 · 고정 좌표 기준', d.bearing.ballWorldRpm, 'rpm', 1),
      fact('볼 중심 궤도 지름', BEARING_DETAIL.pitchRadiusM * 2000, 'mm', 2), fact('볼 지름', BEARING_DETAIL.ballRadiusM * 2000, 'mm', 2)],
    note: '외륜 고정·접촉각 0·미끄럼 없음의 대표 운동학입니다. 볼 자전은 케이지에 대한 상대 회전수가 아닌 고정 좌표 기준입니다. 하중·유격 변화·마찰·수명·온도는 풀지 않으며 평균 모터 마찰을 베어링별로 배분하지 않습니다.',
  };
  if (partId.startsWith('terminal-') || partId.startsWith('lead-')) return {
    facts: [fact('적용 단자 전압', e.sourceV, 'V', 3), current(), fact('전원 공급 동력 · 모터 유입 +', p.supplyW, 'W', 3),
      fact('전기자 저항 전압', e.resistiveV, 'V', 3), fact('평균 역기전력', e.backEmfV, 'V', 3), fact('인덕턴스 전압', e.inductiveV, 'V', 3)],
    note: '전압 항은 V = Ri + Keω + Ldi/dt의 부호를 유지합니다. 음의 공급 동력은 이상 전원으로 에너지가 돌아감을 뜻합니다. 0 V는 단락 조건이며 전류나 손실이 반드시 0인 것은 아닙니다.',
  };
  if (partId === 'housing' || partId.startsWith('endbell-')) return {
    facts: [fact('하우징 외경', G.housingOuterRadius * 2000, 'mm', 1), fact('하우징 벽 두께', (G.housingOuterRadius - G.housingInnerRadius) * 1000, 'mm', 1),
      fact('앞뒤 베어링 중심 거리', (G.bearingCentersX[1] - G.bearingCentersX[0]) * 1000, 'mm', 1),
      fact('전체 점성 마찰 손실', p.frictionW, 'W', 3), fact('전체 누적 마찰 손실', d.energyJ.friction, 'J', 4), fact('부품 온도·응력·진동', '계산하지 않음')],
    note: '형상은 부품의 연결과 공간을 설명합니다. 손실은 모터 전체의 평균 점성 마찰 값이며 하우징이나 엔드벨에서 발생하는 국부 발열로 배분하지 않습니다.',
  };
  if (partId === 'motor-mount') return {
    facts: [fact('축 조건', d.locked ? '축 고정' : '자유 회전'), fact('고정축 구속반력', m.constraintNm * 1000, 'mN·m', 2),
      fact('평균 전자기 토크', m.electromagneticNm * 1000, 'mN·m', 2), fact('현재 각가속도', m.accelerationRadS2, 'rad/s²', 2),
      fact('브래킷 응력·진동', '계산하지 않음')],
    note: '고정축 반력은 locked 실험의 이상적 회전 구속입니다. 실제 브래킷의 반력 분포를 푼 값이 아닙니다. 고정축은 회전 속도가 0이므로 이 반력의 기계적 일률도 0입니다.',
  };
  if (partId === 'test-base') return {
    facts: [fact('전원 공급 동력 · 모터 유입 +', p.supplyW, 'W', 3), fact('전체 전기자 구리 손실', p.copperW, 'W', 3),
      fact('전체 점성 마찰 손실', p.frictionW, 'W', 3), fact('부하 흡수 동력', p.loadW, 'W', 3),
      fact('자기 저장 에너지 변화율', p.magneticStorageW, 'W', 3), fact('회전 저장 에너지 변화율', p.kineticStorageW, 'W', 3)],
    note: '공급 = 구리 손실 + 마찰 손실 + 부하 흡수 + 자기 저장 변화 + 회전 저장 변화입니다. 저장 변화와 공급은 음수가 될 수 있습니다. 내부 전자기 변환 동력을 다시 더하거나 순간 동력비를 효율로 표시하지 않습니다.',
  };
  return { facts: [], note: '이 부품에 대한 별도 계산값은 없습니다.' };
}
