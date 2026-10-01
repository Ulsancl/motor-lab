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
