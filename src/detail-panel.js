import { describeMotorDetail } from './detail-readouts.js';

const $ = selector => document.querySelector(selector);
const format = (value, digits = 2) => (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const settingNumber = value => value.toLocaleString('ko-KR', { maximumFractionDigits: 9 });
function quantity(selector, value, unit, digits = 2) {
  const node = $(selector); node.dataset.value = String(value);
  node.textContent = `${format(value, digits)} ${unit}`;
}
function facts(selector, rows) {
  $(selector).replaceChildren(...rows.map(row => {
    const item = document.createElement('div'); item.className = 'detail-fact';
    Object.assign(item.dataset, { label: row.label, value: String(row.value), unit: row.unit ?? '' });
    const term = document.createElement('dt'), value = document.createElement('dd');
    term.textContent = row.label;
    value.textContent = typeof row.value === 'number' ? `${format(row.value, row.digits ?? 2)}${row.unit ? ` ${row.unit}` : ''}` : String(row.value);
    item.append(term, value); return item;
  }));
}
function signedBars(prefix, values, unit, digits) {
  const scale = Math.max(...Object.values(values).map(Math.abs), 1e-12);
  for (const [key, value] of Object.entries(values)) {
    const bar = $(`#${prefix}-bar-${key}`), width = Math.abs(value) / scale * 50;
    bar.dataset.value = String(value); bar.dataset.scale = String(scale);
    bar.style.width = `${width}%`; bar.style.left = `${value < 0 ? 50 - width : 50}%`;
    quantity(`#${prefix}-value-${key}`, value, unit, digits);
  }
  $(`#${prefix}-scale`).textContent = `막대 중심은 0 · 양끝 ±${format(scale, digits)} ${unit}`;
}
export function renderMotorDetails(state, snapshot, view, detail) {
  const selected = describeMotorDetail(view.selectedPart, state, snapshot);
  facts('#part-detail-facts', selected.facts); facts('#focus-detail-facts', selected.facts);
  $('#part-detail-note').textContent = selected.note; $('#focus-detail-note').textContent = selected.note;
  $('#focus-part-select').value = view.selectedPart;
  const reference = `적용 조건 ${settingNumber(state.settings.voltageV)} V · 부하 ${settingNumber(state.settings.loadCoefficient * 100000)}% · ${state.locked ? '축 고정' : '자유 회전'}`;
  $('#detail-reference').textContent = reference; $('#focus-detail-reference').textContent = reference;
  const e = detail.electrical, m = detail.mechanical;
  signedBars('voltage', { source: e.sourceV, resistance: e.resistiveV, emf: e.backEmfV, induction: e.inductiveV }, 'V', 3);
  quantity('#current-rate', e.currentRateAps, 'A/s', 2);
  $('#voltage-note').textContent = e.currentRateAps < -1e-7 ? '전류가 감소하고 있습니다. 인덕턴스 항은 음수가 될 수 있습니다.' : e.currentRateAps > 1e-7 ? '인덕턴스가 전류의 상승 속도를 정합니다.' : '전류 변화가 작아 인덕턴스 항이 0에 가깝습니다.';
  signedBars('torque', { electromagnetic: m.electromagneticNm * 1000, friction: m.frictionNm * 1000, load: m.loadNm * 1000, constraint: m.constraintNm * 1000, net: m.netNm * 1000 }, 'mN·m', 3);
  quantity('#angular-acceleration', m.accelerationRadS2, 'rad/s²', 2);
  $('#torque-note').textContent = state.locked ? '축 고정 반력이 전자기 토크를 상쇄합니다. 회전 출력은 0입니다.' : '부호는 +X 회전 방향을 기준으로 합니다. 토크 합이 회전 가속도를 정합니다.';
  quantity('#steady-current', detail.steady.currentA, 'A', 3); quantity('#steady-rpm', detail.steady.rpm, 'rpm', 1);
  quantity('#steady-emf', detail.steady.backEmfV, 'V', 3);
  quantity('#storage-magnetic-rate', detail.power.magneticStorageW, 'W', 3); quantity('#storage-kinetic-rate', detail.power.kineticStorageW, 'W', 3);
  $('#storage-rate-note').textContent = '양수는 저장 에너지 증가, 음수는 방출입니다. 저장량 자체가 음수라는 뜻은 아닙니다.';
  $('#steady-reference-note').textContent = `현재 적용한 ${settingNumber(state.settings.voltageV)} V와 부하 ${settingNumber(state.settings.loadCoefficient * 100000)}%를 계속 유지할 때의 평형값입니다. 현재 과도 상태나 저장된 비교 기록을 바꾸지 않습니다.`;
}
