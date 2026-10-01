// Pure SI construction data. No renderer, DOM or model integration is involved.
export const TAU = Math.PI * 2;
const deg = value => value * Math.PI / 180;
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
export const GEOMETRY_SI = deepFreeze({
  axisY: .070, axisZ: 0,
  housingX: [-.054, .035], housingInnerRadius: .028, housingOuterRadius: .030,
  rearEndbellX: [-.062, -.054], frontEndbellX: [.035, .043],
  shaftX: [-.067, .055], shaftRadius: .003,
  bearingCentersX: [-.058, .039], bearingLength: .008, bearingOuterRadius: .007,
  coreX: [-.020, .020], coreHubRadius: .007, coreOuterRadius: .021,
  windingOuterRadius: .022, magnetX: [-.024, .024], magnetInnerRadius: .0235, magnetOuterRadius: .0275, magnetArcRad: deg(140),
  commutatorX: [-.048, -.034], commutatorRadius: .010, commutatorHubRadius: .007,
  segmentArcRad: deg(118), segmentGapRad: deg(2), segmentCentersRad: [0, TAU / 3, 2 * TAU / 3],
  brushCenterX: -.041, brushWidthX: .008, brushArcRad: deg(12), brushOuterRadius: .018,
  brushMountX: [-.056, -.050], supplyTopY: .040, terminalContactY: .043,
  brushAnglesRad: { positive: Math.PI / 2, negative: 3 * Math.PI / 2 },
  leadWireRadius: .00022,
  couplingX: [.049, .065], couplingOuterRadius: .008,
  loadShaftX: [.059, .117], loadRotorX: [.075, .095], loadRotorRadius: .024, loadHousingX: [.069, .107], loadHousingRadius: .030,
  coils: [
    { id: 'coil-a', name: '권선 A', from: 'segment-0', to: 'segment-1', axisRad: -Math.PI / 6, color: '#c78852' },
    { id: 'coil-b', name: '권선 B', from: 'segment-1', to: 'segment-2', axisRad: Math.PI / 2, color: '#d9aa67' },
    { id: 'coil-c', name: '권선 C', from: 'segment-2', to: 'segment-0', axisRad: 7 * Math.PI / 6, color: '#ad684d' },
  ],
});
export const DEFAULT_VIEW = deepFreeze({ mode: 'cutaway', explode: .35, labels: true,
  layers: { housing: true, magnets: true, windings: true, contacts: true, field: false },
  currentArrows: true, selectedPart: 'armature-core' });

const data = [
  ['housing', '강철 하우징', '자석·엔드벨을 고정하고 자기 회로의 귀환 경로를 이루는 두께 있는 케이스입니다.', '강철'],
  ['endbell-front', '출력측 엔드벨', '출력축 베어링을 하우징에 지지하는 전면 덮개입니다.', '알루미늄 합금'],
  ['endbell-rear', '정류자측 엔드벨', '뒤쪽 베어링과 절연 브러시 지지 구조를 고정합니다.', '금속·절연 수지'],
  ['magnet-n', 'N극 영구자석', '안쪽 면이 N극인 고정 자석입니다. 자석과 회전자 사이에 공극이 있습니다.', '페라이트 자석'],
  ['magnet-s', 'S극 영구자석', '안쪽 면이 S극인 고정 자석입니다. 자기력선은 방향을 돕는 도식입니다.', '페라이트 자석'],
  ['shaft', '회전축', '철심과 정류자를 함께 회전시키며 커플링으로 토크를 전달합니다.', '강철'],
  ['armature-core', '적층 전기자 철심', '세 개의 치와 슬롯으로 권선을 지지합니다. 실제 철손·코깅은 이 평균 모형에 포함하지 않습니다.', '적층 전기강판'],
  ['slot-insulation', '슬롯 절연', '구리 권선이 철심과 직접 전기적으로 접촉하지 않도록 분리합니다.', '절연 필름'],
  ['coil-a', '권선 A · S0–S1', '양 끝이 정류자 S0와 S1로 이어집니다. 색은 권선의 식별이며 순간 가지 전류의 계산값이 아닙니다.', '에나멜 구리선'],
  ['coil-b', '권선 B · S1–S2', '양 끝이 정류자 S1과 S2로 이어집니다. 정류 중 유도성 가지 전류는 계산하지 않습니다.', '에나멜 구리선'],
  ['coil-c', '권선 C · S2–S0', '양 끝이 정류자 S2와 S0로 이어져 세 권선의 폐회로를 이룹니다.', '에나멜 구리선'],
  ['commutator-hub', '정류자 절연 허브', '구리 정류자 편을 축에서 절연하고 회전축에 고정합니다.', '절연 수지'],
  ['segment-0', '정류자 S0', '권선 A의 시작과 C의 끝이 연결됩니다. 브러시와 닿는 면을 실제 각도에서 강조합니다.', '구리 합금'],
  ['segment-1', '정류자 S1', '권선 B의 시작과 A의 끝이 연결됩니다. 인접 편 사이에는 절연 간극이 있습니다.', '구리 합금'],
  ['segment-2', '정류자 S2', '권선 C의 시작과 B의 끝이 연결됩니다. 정류자는 회전자와 함께 회전합니다.', '구리 합금'],
  ['brush-positive', '+ 단자 브러시', '고정된 곡면 접점으로 회전 정류자에 닿습니다. 폭 때문에 두 편을 동시에 덮는 구간이 있습니다.', '구리·흑연'],
  ['brush-negative', '− 단자 브러시', '반대쪽 고정 브러시입니다. 단자 평균 전류는 조건에 따라 음수가 될 수 있습니다.', '구리·흑연'],
  ['brush-holder-positive', '+ 브러시 홀더', '브러시를 방사 방향으로 안내하고 금속 케이스에서 절연합니다.', '절연 수지'],
  ['brush-holder-negative', '− 브러시 홀더', '반대쪽 브러시의 위치를 유지합니다. 홀더는 회전하지 않습니다.', '절연 수지'],
  ['brush-spring-positive', '+ 브러시 스프링', '브러시를 정류자 외주 쪽으로 눌러 접촉을 유지합니다.', '스프링 강'],
  ['brush-spring-negative', '− 브러시 스프링', '고정 지지부에서 반대쪽 브러시를 누르는 스프링입니다.', '스프링 강'],
  ['bearing-front', '출력측 베어링', '축과 엔드벨 사이에서 회전을 지지합니다. 내륜은 축에, 외륜은 지지 좌면에 연결됩니다.', '베어링 강'],
  ['bearing-rear', '뒤쪽 베어링', '정류자 뒤에서 축의 반대쪽 끝을 지지합니다.', '베어링 강'],
  ['terminal-positive', '+ 전원 단자', '시험 전원의 + 기준 단자가 절연 리드와 브러시로 이어집니다.', '황동·절연 수지'],
  ['terminal-negative', '− 전원 단자', '시험 전원의 − 기준 단자입니다. 전원은 전류를 공급하거나 흡수하는 이상적 전원입니다.', '황동·절연 수지'],
  ['lead-positive', '+ 단자 리드', '전원과 고정 브러시 사이의 배선입니다. 화살표는 계산된 평균 단자 전류 방향입니다.', '구리·절연 피복'],
  ['lead-negative', '− 단자 리드', '반대쪽 단자 배선입니다. 내부 권선 색과 전류 방향 표시는 서로 다른 의미입니다.', '구리·절연 피복'],
  ['coupling', '축 커플링', '모터축과 부하축의 끝을 연결해 회전과 토크를 전달합니다.', '알루미늄·탄성체'],
  ['load-rotor', '시험 부하 회전부', '모터와 함께 회전합니다. 부하 토크는 속도에 비례하는 이상적인 시험 부하입니다.', '강철'],
  ['load-housing', '시험 부하 지지부', '동축 부하 회전부를 양 끝에서 지지합니다. 실제 동력계의 전자기장이나 열은 계산하지 않습니다.', '금속'],
  ['motor-mount', '모터 고정 브래킷', '하우징과 엔드벨을 시험대에 고정해 반력을 받습니다.', '도장 강철'],
  ['test-base', '전원·실험 받침대', '모터와 부하를 고정하는 관찰용 시험대입니다. 총 관성은 별도의 모형 상수입니다.', '알루미늄·강철'],
];
export const COMPONENTS = deepFreeze(data.map(([id, name, description, material]) => ({ id, name, description, material })));

export function wrapAngle(angle) {
  if (!Number.isFinite(angle)) throw new TypeError('angleRad must be finite');
  const result = ((angle % TAU) + TAU) % TAU; return Object.is(result, -0) ? 0 : result;
}
const signed = angle => { const value = wrapAngle(angle + Math.PI) - Math.PI; return Object.is(value, -0) ? 0 : value; };
export function sampleCommutation(thetaRad) {
  const angleRad = wrapAngle(thetaRad), halfCopper = GEOMETRY_SI.segmentArcRad / 2, halfBrush = GEOMETRY_SI.brushArcRad / 2;
  const contact = beta => GEOMETRY_SI.segmentCentersRad.flatMap((center, index) => {
    const d = signed(angleRad + center - beta);
    const overlapRad = Math.max(0, Math.min(halfBrush, d + halfCopper) - Math.max(-halfBrush, d - halfCopper));
    return overlapRad > 1e-12 ? [{ segmentId: `segment-${index}`, overlapRad }] : [];
  });
  const positive = contact(GEOMETRY_SI.brushAnglesRad.positive), negative = contact(GEOMETRY_SI.brushAnglesRad.negative);
  const bridgedCoils = GEOMETRY_SI.coils.filter(coil => [positive, negative].some(contacts => contacts.some(c => c.segmentId === coil.from) && contacts.some(c => c.segmentId === coil.to))).map(coil => coil.id);
  return { angleRad, positive, negative, bridgedCoils };
}
export const brushContacts = sampleCommutation;

// Rotor-local positions have their axis at y=z=0. World conversion is explicit.
export function radialPoint(x, radius, angle) { return [x, radius * Math.cos(angle), radius * Math.sin(angle)]; }
export function rotorToWorld(point, angleRad = 0) {
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  return [point[0], GEOMETRY_SI.axisY + point[1] * c - point[2] * s, point[1] * s + point[2] * c];
}
export function coilEndpoints(coilIndex) {
  const coil = GEOMETRY_SI.coils[coilIndex]; if (!coil) throw new RangeError('Unknown coil');
  const c = Math.cos(coil.axisRad), s = Math.sin(coil.axisRad);
  return [-1, 1].map(side => [-.027, .013 * c - side * .004 * s, .013 * s + side * .004 * c]);
}

export const COIL_LEAD_ROUTES = deepFreeze(GEOMETRY_SI.coils.flatMap((coil, index) => coilEndpoints(index).map((start, end) => {
  const lane = index * 2 + end, radius = .018 + lane * .0008, laneX = -.028 - lane * .0008;
  const segmentId = end ? coil.to : coil.from, segment = Number(segmentId.slice(-1));
  const targetAngle = GEOMETRY_SI.segmentCentersRad[segment] + deg(end ? 20 : -20);
  const startAngle = Math.atan2(start[2], start[1]), sweep = signed(targetAngle - startAngle);
  const points = [start, [-.0275, start[1], start[2]], radialPoint(-.0275, radius, startAngle), radialPoint(laneX, radius, startAngle)];
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / deg(3)));
  for (let i = 1; i <= steps; i++) points.push(radialPoint(laneX, radius, startAngle + sweep * i / steps));
  points.push(radialPoint(-.033, radius, targetAngle), radialPoint(-.0335, .010, targetAngle), radialPoint(-.034, .010, targetAngle));
  return { id: `${coil.id}-${end ? 'end' : 'start'}`, coilId: coil.id, segmentId, radiusM: GEOMETRY_SI.leadWireRadius, points };
})));

// A single continuous representative winding around a radial tooth. The two
// pigtails meet exactly the separately exported commutator lead endpoints.
export function coilWindingPoints(index) {
  const coil = GEOMETRY_SI.coils[index]; if (!coil) throw new RangeError('Unknown coil');
  const ends = coilEndpoints(index), points = [ends[0]], turns = 11;
  const p = (x, radius, tangent) => [x, radius * Math.cos(coil.axisRad) - tangent * Math.sin(coil.axisRad), radius * Math.sin(coil.axisRad) + tangent * Math.cos(coil.axisRad)];
  for (let i = 0; i < turns; i++) {
    const r = .0094 + i * .00065;
    points.push(p(-.0248, r, -.0043), p(.0248, r, -.0043), p(.0248, r, .0043), p(-.0248, r, .0043));
  }
  points.push(ends[1]); return points;
}

export const EXTERNAL_LEADS = deepFreeze({
  positive: [[-.094, .043, .040], [-.094, .055, .048], [-.074, .055, .048], [-.060, .070, .038], [-.051, .070, .026], [-.041, .070, .021], [-.041, .070, .017]],
  negative: [[-.094, .043, .025], [-.108, .055, .025], [-.109, .05, -.041], [-.070, .065, -.041], [-.051, .070, -.026], [-.041, .070, -.021], [-.041, .070, -.017]],
});
