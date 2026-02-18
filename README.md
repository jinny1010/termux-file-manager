# 📂 TermuxFM - SillyTavern용 파일 매니저

Termux에서 실행 중인 SillyTavern에 웹 기반 파일 매니저를 추가합니다.
브라우저에서 편하게 파일 업로드/다운로드/삭제/이동/백업/복원이 가능합니다.

---

## 🚀 설치 방법

### 1단계: 파일 복사

이 폴더(`termux-file-manager`)를 SillyTavern의 plugins 폴더에 넣으세요.

```bash
# 방법 A: 내부저장소에서 복사하는 경우
cp -r /sdcard/Download/termux-file-manager ~/SillyTavern/plugins/

# 방법 B: 이미 홈에 있는 경우
cp -r ~/termux-file-manager ~/SillyTavern/plugins/
```

### 2단계: 의존성 설치

```bash
cd ~/SillyTavern/plugins/termux-file-manager
npm install
```

### 3단계: SillyTavern 설정

`config.yaml`에서 플러그인을 활성화합니다:

```yaml
# config.yaml에 아래 내용 추가/수정
enableServerPlugins: true
```

### 4단계: SillyTavern 재시작

```bash
cd ~/SillyTavern
node server.js
```

콘솔에 `[termux-file-manager] File Manager API ready` 메시지가 뜨면 성공!

### 5단계: 접속

브라우저에서:
```
http://localhost:8000/api/plugins/termux-file-manager/
```

또는 SillyTavern이 다른 포트를 쓴다면 해당 포트로 접속.

---

## ⚡ 주요 기능

| 기능 | 설명 |
|------|------|
| 📂 파일 탐색 | 홈 디렉토리 내 모든 폴더/파일 탐색 |
| 📤 업로드 | 드래그&드롭 또는 클릭으로 파일 업로드 |
| 📥 다운로드 | 파일 선택 후 다운로드 |
| ✏️ 이름 변경 | 파일/폴더 이름 변경 |
| 🗑 삭제 | 파일/폴더 삭제 |
| 📁 새 폴더 | 폴더 생성 |
| 👁 미리보기 | 텍스트 파일 내용 미리보기 |
| 💾 백업 | SillyTavern data + config.yaml 원클릭 백업 |
| 🔄 복원 | 백업 파일에서 원클릭 복원 |

---

## 🔑 사용법

### 파일 업로드 (캐릭터 카드 넣기 등)
1. 웹에서 TermuxFM 열기
2. `SillyTavern/data/default-user/characters` 폴더로 이동
3. 📤 업로드 버튼 클릭
4. .png 캐릭터 카드 파일 선택
5. 완료!

### 백업하기
1. 💾 백업 버튼 클릭
2. 홈 디렉토리에 `st-backup-날짜.tar.gz` 파일 생성됨
3. 해당 파일을 다운로드하여 안전한 곳에 보관

### 복원하기
1. 백업 파일을 업로드 (홈 디렉토리에)
2. 🔄 복원 버튼 클릭
3. 백업 파일명 입력
4. SillyTavern 재시작

---

## ⚠️ 주의사항

- 홈 디렉토리(`~`) 밖으로는 접근할 수 없습니다 (보안)
- 대용량 파일 업로드는 최대 500MB까지 지원
- 텍스트 미리보기는 2MB까지 지원
- **SillyTavern이 플러그인을 자동 로드하지 않는 경우**, 아래 대안을 사용하세요

---

## 🔧 대안: 독립 실행 모드

SillyTavern 플러그인 시스템이 작동하지 않는 경우,
별도 서버로 실행할 수 있습니다:

```bash
cd ~/termux-file-manager
node standalone.js
```

이 경우 별도 포트(8001)에서 접속 가능합니다.
