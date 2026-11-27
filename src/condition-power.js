const terms = [
  ['supplyW', '전원 입력', 'supply'],
  ['copperW', '구리 손실', 'loss'],
  ['frictionW', '내부 마찰', 'loss'],
  ['loadW', '시험 부하', 'loss'],
  ['magneticStorageW', '자기 에너지 변화율', 'storage'],
  ['kineticStorageW', '회전 에너지 변화율', 'storage'],
];
const watts = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const settingsNumber = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 9 });
let budget;

function mountBudget() {
  const card = document.createElement('section');
  card.className = 'power-budget';
  card.setAttribute('aria-labelledby', 'power-budget-title');
  card.innerHTML = `
    <div class="power-budget-heading">
      <h3 id="power-budget-title">실시간 전력 수지</h3>
      <span class="power-budget-phase"></span>
    </div>
    <p class="power-budget-condition" role="status"></p>
    <div class="power-budget-axis">
      <span class="power-budget-scale"></span>
      <div><span class="power-budget-min"></span><span>0</span><span class="power-budget-max"></span></div>
    </div>
    <dl class="power-budget-terms">
      ${terms.map(([, label, type]) => `
        <div class="power-budget-term power-budget-${type}">
          <dt>${label}</dt>
          <dd><span class="power-budget-track" aria-hidden="true"><i></i></span><span class="power-budget-value"></span></dd>
        </div>`).join('')}
    </dl>
    <p class="power-budget-note">전원 입력은 손실·부하와 두 저장 변화율의 합입니다. 음의 입력은 전원의 흡수, 음의 저장 변화율은 에너지 방출을 뜻합니다.</p>`;
  document.querySelector('.workbench .metrics').after(card);
  const select = selector => card.querySelector(selector);
  return {
    condition: select('.power-budget-condition'),
    phase: select('.power-budget-phase'),
    scaleLabel: select('.power-budget-scale'),
    min: select('.power-budget-min'),
    max: select('.power-budget-max'),
    meters: [...card.querySelectorAll('.power-budget-term')].map(row => ({
      fill: row.querySelector('i'),
      reading: row.querySelector('.power-budget-value'),
    })),
  };
}

function responsePhase(state, detail) {
  const { voltageV } = state.settings;
  if (state.timeS === 0 && voltageV > 0) return '시동 대기';
  const { currentA, rpm, steady, electrical, power } = detail;
  const currentNear = Math.abs(currentA - steady.currentA) <= Math.max(.001, Math.abs(steady.currentA) * .02);
  const speedNear = Math.abs(rpm - steady.rpm) <= Math.max(1, Math.abs(steady.rpm) * .02);
  if (currentNear && speedNear) return voltageV > 0 ? '평형 근처' : '정지 근처';
  if (state.locked) return electrical.currentRateAps > 0 ? '전류 상승 중' : '전류 감소 중';
  if (voltageV > 0 && rpm >= 0 && rpm < steady.rpm * .05 && electrical.currentRateAps > 0) return '시동 · 전류 상승';
  if (power.kineticStorageW > .001) return '회전 에너지 저장 중';
  if (power.kineticStorageW < -.001) return voltageV === 0 ? '전기 제동' : '회전 에너지 방출 중';
  return '평형으로 이동 중';
}

export function renderConditionPower(state, snapshot, detail) {
  budget ??= mountBudget();
  const { voltageV, loadCoefficient } = state.settings;
  const { resistanceOhm, inertiaKgM2 } = snapshot;
  const condition = `적용 중 ${settingsNumber.format(voltageV)} V · 부하 ${settingsNumber.format(loadCoefficient * 100000)}% · ${state.locked ? '축 고정' : '자유 회전'} · R ${settingsNumber.format(resistanceOhm)} Ω · J ${settingsNumber.format(inertiaKgM2 * 1000)} g·m²`;
  if (budget.condition.textContent !== condition) budget.condition.textContent = condition;
  const phase = responsePhase(state, detail);
  if (budget.phase.textContent !== phase) budget.phase.textContent = phase;

  const values = terms.map(([key]) => detail.power[key]);
  const largest = Math.max(1, ...values.map(Math.abs));
  const decade = 10 ** Math.floor(Math.log10(largest));
  const scale = decade * [1, 2, 5, 10].find(multiplier => multiplier * decade >= largest);
  if (budget.scale !== scale) {
    budget.scale = scale;
    const kilowatts = scale >= 1000;
    const extent = settingsNumber.format(kilowatts ? scale / 1000 : scale);
    budget.scaleLabel.textContent = `자동 눈금 (${kilowatts ? 'kW' : 'W'})`;
    budget.min.textContent = `−${extent}`;
    budget.max.textContent = `+${extent}`;
  }
  budget.meters.forEach(({ fill, reading }, index) => {
    const value = values[index];
    fill.style.setProperty('--power-ratio', value / scale);
    reading.dataset.value = String(value);
    const label = `${watts.format(Math.abs(value) < .005 ? 0 : value)} W`;
    if (reading.textContent !== label) reading.textContent = label;
  });
}
