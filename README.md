<div align="center">
  <img src="assets/icon/whennote.png" width="96" alt="WHENNOTE">
  <h1>WHENNOTE</h1>
  <p><b>떠오른 생각을 단축키 한 번으로 적어 두고, 몇 글자로 다시 찾는다.</b></p>
  <p>Windows · macOS 트레이 상주 메모 앱 · 한국어</p>
</div>

---

순수 메모 앱입니다. 할 일·마감·일정은 다루지 않습니다 — 그건 형제 앱 [WHENWORK](https://github.com/when630/whenwork)의 일입니다.

- **어디서든 1초** — `Ctrl+Alt+N`으로 작은 메모 창이 뜹니다. 저장 버튼은 없습니다. `Esc`로 닫으면 저장됩니다.
- **잃지 않습니다** — 적은 글은 디스크에 먼저 남습니다. 앱이 강제 종료돼도 다음 실행에서 되살아나고, 자동 테스트가 실제로 프로세스를 죽여 가며 이를 증명합니다.
- **몇 글자로 찾습니다** — 검색창이 곧 입력창입니다. 부분 문자열, 한글 초성(`ㅎㅇ` → 회의), `#태그`로 찾고, 없으면 `Shift+Enter`로 그 문장이 새 메모가 됩니다.
- **정리는 태그와 링크만** — 폴더가 없습니다. 본문의 `#태그`와 `[[다른 메모]]`가 곧 정리이고, 백링크가 연결을 보여줍니다.

## 상태

개발 초기(Phase 1 트레이서). 설치 파일은 아직 없습니다. 문서는 [`docs/`](docs/)에 있습니다.

## 직접 빌드하기

```bash
npm install          # postinstall이 아이콘을 굽는다
npm start            # 개발 실행
npm test             # 전체 테스트
npm run smoke        # 창을 띄우지 않고 렌더러까지 자가진단
npm run smoke:crash  # 캡처 직후 강제 종료해도 살아남는지 (실제 프로세스를 죽인다)
npm run build        # Windows 설치 파일 → dist/
```

Node 22 이상이 필요합니다(저장소가 `node:sqlite`를 씁니다). 개발 실행과 설치본은 같은 데이터 폴더(`whennote`)를 공유합니다.

## 만들어진 방식

WHENWORK와 같은 스택·구조·배포 방식을 그대로 씁니다: Electron + vanilla JS, `node:sqlite` 단일 파일 저장소, 큐 선기록, `main/platform/` 안에만 있는 OS 분기, 미서명 GitHub Releases. 검증된 모듈은 복사해 시작했고 두 앱은 코드를 공유하지 않습니다. 결정 기록은 [docs/03_기술_스펙.md](docs/03_기술_스펙.md)에 있습니다.

## 라이선스

코드는 MIT. 번들된 [Pretendard](https://github.com/orioncactus/pretendard) 글꼴은 SIL Open Font License 1.1을 따릅니다.
