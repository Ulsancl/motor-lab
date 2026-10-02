# Motor Lab 계산 모형

Motor Lab은 영구자석 브러시 DC 모터의 평균 전기·기계 응답을 관찰하는 프로그램이다. 모형 식별자는 `motor-dc-average-1`이다. 화면의 코일·브러시·정류자 형상과 별개로, 전기자는 하나의 저항·인덕턴스·역기전력으로 계산한다. 특정 제조사 모터의 측정값이나 정격을 재현한 모형은 아니다.

## 물리량과 입력

| 기호 / API | 값 또는 범위 | 의미 |
| --- | --- | --- |
| `resistanceOhm` / R | 2 Ω | 전기자 저항 |
| `inductanceH` / L | 0.004 H | 전기자 인덕턴스 |
| `torqueConstantNmPerA` / Kt | 0.04 N·m/A | 평균 전자기 토크 상수 |
| `backEmfConstantVsPerRad` / Ke | 0.04 V·s/rad | 평균 역기전력 상수 |
| `inertiaKgM2` / J | 0.0004 kg·m² | 등가 회전 관성 |
| `frictionCoefficient` / b | 0.00002 N·m·s/rad | 모터 내부 점성 마찰 |
| `settings.voltageV` / V | 0–12 V, 기본 6 V | 이상적 양방향 전력 흐름을 허용하는 전압원 |
| `settings.loadCoefficient` / bL | 0–0.001 N·m·s/rad, 기본 0 | 속도에 비례하는 외부 부하 계수 |

Kt와 Ke는 일관된 SI 단위에서 같은 수치를 사용한다. 평균 모터의 전압식·토크식은 [University of Michigan CTMS의 DC Motor Speed 모형](https://ctms.engin.umich.edu/CTMS/?example=MotorSpeed&section=SystemModeling) 및 [IIT Kharagpur Virtual Labs의 DC 모터 식](https://vlabs.iitkgp.ac.in/dctrl/Exp5/theory.html)에 제시된 형태를 따른다. 위 상수와 관찰 범위는 이 프로그램이 선택한 예시값이다.

회전 각속도는 ω, 평균 전류는 i이며 식은 다음과 같다.

```text
L di/dt = V − R i − K ω
J dω/dt = K i − (b + bL) ω
dθ/dt = ω
역기전력 = K ω
전자기 토크 = K i
외부 부하 토크 = bL ω  (회전식에서 빼는 항)
```

모터축을 처음부터 고정한 실험은 `locked: true`이다. 이때 ω=0, 각도는 일정하고 전류만 RL 식을 따른다. 고정 지지대의 반력 토크는 −Ki, 기계적 일률은 0이다. 회전 도중 고정 여부를 바꾸는 충격 모형은 제공하지 않으므로 고정축 실험은 새 실험으로 시작한다.

**0 V는 전기자를 이상적 전압원으로 단락한 상태**다. 회전자의 관성과 역기전력은 즉시 사라지지 않으며, 전류가 음수가 되어 제동할 수 있다. 개방 회로, 전원 플러그 분리 또는 일반적인 회생 불가능 전원 장치와 같지 않다. 전압을 낮췄을 때 음의 전류와 음의 공급 일률은 지우지 않는다.

## 에너지의 의미

순간값 `powerW`는 W 단위이며, 누적값 `energyJ`는 J 단위이다. 누적 공급 에너지는 전원이 모터에 준 값을 양수로, 전원으로 돌아간 값을 음의 증가량으로 센다. 손실과 외부 부하 에너지는 각각 독립적으로 적분한다.

| 키 | 순간값 | 누적값 |
| --- | --- | --- |
| `supply` | Vi, 부호 유지 | ∫Vi dt |
| `copper` | Ri² | ∫Ri² dt |
| `friction` | bω² | ∫bω² dt |
| `load` | bLω² | ∫bLω² dt |
| `electromagnetic` | Kiω, 내부 변환 일률 | 별도 누적 없음 |
| `storageRate` | Li·di/dt + Jω·dω/dt | 별도 누적 없음 |

`storedEnergyJ`는 `magnetic = Li²/2`, `kinetic = Jω²/2`, 두 값의 합인 `total`을 제공한다. 실험은 저장 에너지 0에서 시작하므로 다음 보존식으로 저장 기록을 검증한다.

```text
E_supply = E_magnetic + E_kinetic + E_copper + E_friction + E_load
```

회생 구간의 공급 **증가량**은 음수일 수 있다. 누적값은 이전 공급과 반환을 모두 포함한다. 저장 에너지의 방출 때문에 순간 부하 일률/공급 일률을 단순한 효율로 읽을 수 없어 이 모형은 그런 비율을 효율로 내보내지 않는다. `electromagnetic`은 내부 변환 항이므로 위 보존식의 우변에 다시 더하지 않는다.

## 시간 적분

전압과 부하가 고정된 각 구간에서 전류·속도·제곱 moment·필요한 적분을 10차원 상수 계수 선형계로 묶는다.

```text
z = [1, i, ω, i², iω, ω², ∫i, ∫ω, ∫i², ∫ω²]
z(t+dt) = exp(M dt) z(t)
```

예를 들어 `(i²)'=2i·i'`, `(iω)'=i'ω+iω'`를 사용하면 모든 항이 z의 선형식이 된다. 구현 내부에서는 i/6 A, ω/300 rad/s로 스케일하여 전기·기계 수치의 크기를 맞춘다. 행렬 1-norm이 1/4 이하가 되도록 스케일한 뒤 18항 Taylor 전개와 반복 제곱으로 전이를 구한다. 매 제곱 후 제곱 moment의 행은 전류·속도 affine 전이의 정확한 곱 관계와 일치시킨다. 에너지 적분 행은 독립적으로 유지한다. 어떤 손실도 보존식의 남은 차액으로 만들지 않는다.

이 방식은 2 ms의 전기적 시간 상수와 훨씬 느린 회전 응답을 고정 Euler 소단계 없이 함께 다룬다. 이 문서에서 해석적 전이라 함은 상수 계수 해를 부동소수점으로 평가한다는 뜻이며, 무오차 계산을 뜻하지 않는다. 캐시는 `(전압, 부하 계수, 고정 여부, dt)`로 구분하고 최근 128개 전이까지만 보관한다. 캐시가 없어져도 저장 state의 의미는 바뀌지 않는다.

`step`은 모델 시간만 전진시킨다. 실제 벽시계와 관찰 재생 배율은 UI의 책임이다. `angleRad`는 [0, 2π)의 위상이고 `interval.angleDeltaRad`는 해당 구간의 전체 회전량이다. 구간 회전량을 화면을 보기 좋게 줄여 계산하지 않는다. 저장 state 자체에는 전체 누적 회전수 필드가 없다.

## 순수 API

```js
createExperiment(settings?, { locked?, angleRad? }?)
normalizeSettings(value)
reconfigureExperiment(state, { voltageV?, loadCoefficient? })
assertValidState(state)
instantSnapshot(state)
step(state, dt) // { state, interval: { durationS, angleDeltaRad, deltaEnergyJ } }
```

`createExperiment`는 설정의 유한 숫자를 지원 범위로 맞추고, 잘못된 타입은 기본값으로 대체한다. 시작 위상은 한 바퀴 범위로 정규화하며, 전류·속도·시간·누적 에너지는 항상 0이다. `reconfigureExperiment`는 범위가 올바른 설정값만 받아들이고 전류·속도·각도·시간·누적 에너지를 그대로 보존한다. 설정을 바꿀 때 물리적 과도 응답을 새로 시작하지 않는다.

`assertValidState`는 성공 시 받은 state를 그대로 반환하고 실패 시 `TypeError` 또는 `RangeError`를 던진다. 저장 입력을 보정하거나 변이하지 않는다. `step`, `reconfigureExperiment` 및 snapshot도 입력 객체를 수정하지 않으며 중첩 설정·에너지 객체를 공유하지 않는다. 유효성 검사는 다음을 포함한다.

- 정확한 필드·모형 버전·boolean 타입, 유한 숫자, 알 수 없는 필드 거부. 저장 수치의 음의 0도 비정규 표현으로 거부한다.
- 각도 [0, 2π), 총 모델 시간 0–1,000,000 s, 1회 dt 0–3,600 s. 시간 상한을 넘거나 양의 dt가 현재 시간에 더해져도 표현 가능한 차이를 만들지 못하면 전진 전에 거부한다.
- 순간 저장 에너지 360 J의 보수적 상한. 개별 전류 한계는 약 ±424.264 A, 속도 한계는 약 ±1341.641 rad/s이다. 이 값들은 파손·정격·사용 권장값이 아니라 잘못된 입력을 차단하는 수학적 한계다.
- 손실 누적은 음수가 될 수 없고, 공급·손실의 누적 크기는 최대 입력·전류 한계와 경과 시간으로 제한한다. 에너지 보존식에는 `1e-8 J + 5e-11 × max(1, |공급|, 총손실, 저장에너지)`의 수치 허용오차를 사용한다.
- 시간 0에는 전류·속도·누적 에너지가 정확히 0이어야 한다. 고정축에는 속도·마찰/부하 누적이 정확히 0이어야 하고 전류는 0–6 A여야 한다(6 A 경계의 계산 오차 5e-10 A 허용).

360 J 상한은 `E' = Vi − Ri² − (b+bL)ω² ≤ 36 − 0.1E`에서 얻는다. 0 에너지로 시작하는 모든 지원 입력 이력에 대해 E≤360이다. 검증은 파일에 담긴 수치의 구조와 보존 관계를 확인하며, 기록되지 않은 과거의 모든 전압·부하 조작을 재구성하거나 실제로 도달 가능한 유일한 이력이 있었음을 증명하지는 않는다. 불러오기 원문 보존과 파일 교체는 프로젝트 코덱·UI의 책임이다.

Snapshot은 `timeS`, `angleRad`, `omegaRadS`, `currentA`, `voltageV`, `backEmfV`, `torqueNm`, `loadTorqueNm`, `loadCoefficient`, `locked`, `rpm`, `constraintTorqueNm`와 위의 `powerW`, `energyJ`, `storedEnergyJ`를 제공한다. 3D 정류자 접촉 위치는 형상 모듈에서 계산하며 이 평균 모형의 전류를 개별 코일 전류로 해석하면 안 된다.

## 검사와 한계

`node --test tests/model.test.mjs`는 잠긴 축의 독립 RL 해석해와 작은 시간용 급수, 자유 회전의 독립적인 두 실지수 해 및 각 에너지 적분, 정상 상태 회로·토크 평형, 음의 회생 전류, 단락 제동, 이동 중 부하 변경을 검증한다. 긴 구간/작은 구간의 분할 비교, 5,000개 작은 구간, 총 1,000,000 s, 여러 전압·부하 변경, 저장 기록의 모순·비유한 값·변이 방지도 검사한다. 비교해는 생산 행렬 적분 코드를 다시 호출하지 않는다.

이상적 일정 자속·고정 R/L/J/K, 점성 마찰과 속도 비례 부하만 포함한다. 권선 온도 변화, 열용량·과열 시간, 철손, 자기 포화, 코깅, 정류 토크 맥동, 브러시 접촉 저항·스파크, PWM·전자제어기, 실제 배터리/전원 회생 제한, Coulomb 마찰, 기계 유격은 계산하지 않는다. 3D 절개·분해는 관찰 표현이며 치수 기반 전자기 해석이나 제조·정격 판정 결과가 아니다. 실제 설치·표시 성능과 이 순수 계산 검증은 별도 검증 항목이다.

## 1.1 상세 관찰의 도출값

`src/detail-model.js`의 `motorDetail(state, snapshot = instantSnapshot(state))`는 위 평균 모형의 상태를 읽기만 한다. 기존 적분기·상수·상태 필드·모형 식별자 `motor-dc-average-1`과 저장 스키마는 변경하지 않는다. `state`는 기존의 엄격한 유효성 검사를 통과해야 하며, 선택적으로 넘기는 snapshot은 **같은 state의 `instantSnapshot(state)`**여야 한다. 출력은 SI 단위의 독립 객체다. 입력이나 중첩 에너지 기록을 수정하지 않는다.

`describeMotorDetail(partId, state, snapshot)`은 32개 부품에 최대 6개 `{label, value, unit, digits}` 항목과 설명을 제공한다. 표시 단위로의 변환은 여기서만 하며, 각속도·전류 미분은 적용된 모형 조건에서 계산한다. 아직 적용하지 않은 입력란이나 화면 재생 배율은 이 함수의 입력이 아니다. 일시정지 중의 미분값은 그 상태에서 모형 시간을 다시 진행할 때의 순간 변화율이며, 일시정지 동안 상태나 에너지가 진행한다는 뜻이 아니다.

### 전압과 토크의 부호

```text
electrical.sourceV = V
electrical.resistiveV = Ri
electrical.backEmfV = Keω
electrical.inductiveV = V − Ri − Keω = Ldi/dt
electrical.currentRateAps = (V − Ri − Keω) / L

mechanical.electromagneticNm = Kti
mechanical.frictionNm = −bω
mechanical.loadNm = −bLω
mechanical.constraintNm = locked ? −Kti : 0
mechanical.netNm = Kti − bω − bLω + constraintNm
mechanical.accelerationRadS2 = locked ? 0 : (Kti − (b+bL)ω) / J
```

토크 항은 +X 회전을 기준으로 운동식에 **더하는 부호**다. 양의 속도에서 마찰·부하 항은 음수이고 음의 속도에서는 양수다. 기존 snapshot의 `loadTorqueNm = bLω`는 운동식에서 빼는 항이므로 새 상세값 `mechanical.loadNm`과 부호가 반대다. 고정축은 속도 0과 구속반력으로 토크 합이 0이 된다. 그 반력은 실제 브래킷의 응력이나 지지점별 반력 분포가 아니다.

전압 항 역시 부호를 유지한다. 회생 중 `Ri < 0`일 수 있어도 구리 손실 `Ri²`는 음수가 아니다. `electrical.rlTimeConstantS = L/R = 0.002 s`는 전기자 RL 시간 상수이며, 결합된 자유 회전 모터의 전체 응답을 단일 2 ms 지수로 설명하지 않는다.

### 저장 변화와 전력 수지

`power`는 기존 snapshot의 일률과 함께 다음 개별 저장 변화율을 제공한다.

```text
magneticStorageW = Li·di/dt
kineticStorageW = Jω·dω/dt
supplyW = copperW + frictionW + loadW + magneticStorageW + kineticStorageW
supplyW = copperW + electromagneticW + magneticStorageW
electromagneticW = frictionW + loadW + kineticStorageW
```

공급과 저장 변화율은 부호 있는 값이다. 양의 저장 변화율은 축적, 음수는 방출이다. 전자기 변환 `Ktiω`는 전기와 기계 사이의 내부 전달 항이므로 전체 수지의 손실·저장 항과 다시 합하지 않는다. 고정축 기동에서도 전류가 증가하는 동안에는 공급 일부가 자기장에 저장된다. 따라서 축이 멈췄다는 이유만으로 매 순간 공급 전부를 구리 손실로 표시하지 않는다. 0 V 제동에서는 공급 동력 0 W와 음의 전류·양의 구리 손실이 동시에 가능하다.

`electrical.residualV`, `mechanical.residualNm`, `power.residualW`, `power.electricalResidualW`, `power.mechanicalResidualW`, `balance.energyResidualJ`는 각각 위 등식의 좌변에서 우변을 뺀 부동소수점 잔차다. 손실을 잔차로 만들어 보존식을 맞추지 않는다. 순간 동력비를 효율로 만들지 않으며, 손실·흡수 에너지에서 온도나 과열 시간을 도출하지 않는다.

### 같은 조건을 유지할 때의 평형 참조

자유 회전에서 `di/dt = dω/dt = 0`인 회로·토크 식의 교점은 다음과 같다.

```text
ω∞ = KtV / [R(b+bL) + KtKe]
i∞ = (b+bL)V / [R(b+bL) + KtKe]
```

고정축에서는 `ω∞ = 0`, `i∞ = V/R`이다. `steady`는 이 회전수·전류·역기전력·전자기 토크와 공급/구리/마찰/부하 일률을 제공한다. 현재 입력을 계속 유지할 때의 평형 참조일 뿐, 현재 과도 상태를 이 값으로 대체하거나 초기화하지 않는다. 현재 전류·속도·누적 에너지를 그대로 보존하며, 도달 시간을 예측하거나 제조사 정격을 제시하지 않는다. 0 V에서는 참조값이 모두 0이지만 현재 회전과 저장 에너지는 남아 있을 수 있다.

### 접촉 기하와 평균 전류의 경계

정류 접촉은 기존 `GEOMETRY_SI`와 `sampleCommutation(angleRad)`를 그대로 사용한다. 각 브러시가 덮는 각 구리 편의 겹침 각도 `Δφ`에서 곡면 면적 `r·Δφ·w`를 구한다. 여기서 r은 정류자 반경, w는 브러시의 축방향 폭이다. 명목 브러시 면적은 `r·brushArcRad·w`이며, 접촉 편들의 실제 구리 면적 합에는 절연 간극을 제외한다. 예를 들어 30°의 +브러시는 S0·S1을 각각 5°씩 덮고 가운데 2°는 절연 간극이다. 점으로만 맞닿는 경계는 접촉 면적으로 세지 않는다.

`contact.surfaceVelocityMps = rω`는 부호 있는 정류자 표면 속도이고, `passesPerBrushHz = 3|ω|/(2π)`는 현재 속력을 유지할 때 **브러시 하나**를 지나는 편의 빈도다. 두 브러시의 정류 사건을 합한 횟수나 전류 맥동 주파수를 해석한 값이 아니다. 접촉 면적은 압력·전기저항·전류밀도·마모·스파크를 예측하지 않는다. 모형의 R/L/K는 화면의 세 권선·예시 권수·공극에서 계산하지 않으므로 이 값들을 개별 코일에 배분하지 않는다.

### 베어링의 별도 운동학

베어링 순간 회전수는 장면과 같은 `motorBearingKinematics`를 사용한다. 볼 중심 궤도 반경 Rb = 5 mm, 볼 반경 rb = 0.93 mm, 외륜 고정·접촉각 0·미끄럼 없음에서 케이지 각속도는 `ωc = (1 − rb/Rb)ω/2`, 고정 좌표에서 볼 자전 각속도는 `ωball = −(Rb/rb − 1)ω/2`다. 따라서 바깥 접점 속도 `ωcRb + ωball rb = 0`, 안쪽 접점 속도 `ωcRb − ωball rb = ω(Rb−rb)`가 된다. 케이지 기준 상대 자전과 고정 좌표의 자전은 서로 다르다.

`bearing`에는 `innerRpm`, `outerRpm`, `cageRpm`, `ballWorldRpm`만 제공한다. 원래 저장 위상은 한 바퀴 안의 `angleRad`여서 베어링의 누적 위상을 재구성할 수 없다. 시각적 회전 위상은 장면이 실제 `interval.angleDeltaRad`를 한 번씩 누적하며, 새 실험과 복원에서는 관찰 기준을 새로 잡는다. 상세값에 잘못된 감긴 케이지 위상이나 별도 저장 필드를 넣지 않는다. 이 운동학은 베어링 하중·탄성 접촉·유격 변화·마찰·수명·온도 해석이 아니다.

### 추가 검증

`tests/detail-model.test.mjs`는 독립 RL 지수해, 전류·속도·개별 저장량의 중앙 유한차분, 양/음 회전의 부호 있는 수지, 회생과 0 V 제동의 구분, 고정축 반력, 긴 시간 적분과 평형 교점, 접촉 경계와 한 바퀴 면적 적분, 베어링 두 접점의 속도를 비교한다. 32개 부품 항목의 단위·유한값·최대 개수와 원본 불변성도 검사한다. 기존 snapshot과 저장 state에 상세 출력이 섞이지 않는 계약을 유지한다.
