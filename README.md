# FOR:WORD.FINAL

메모를 글로 확장하는 웹 앱 **FOR:WORD**의 Firebase 프로젝트입니다. 정적 호스팅으로 제공되는 프런트엔드와 Genkit 기반 Cloud Functions, Data Connect 스키마 예제가 포함되어 있습니다.

## 구조
- `public/` – 호스팅되는 정적 페이지(홈/로그인/편집기 등).
- `functions/` – Firebase Functions 소스. `genkit-sample.ts`에 Genkit 예시 플로우(`menuSuggestionFlow`)가 정의되어 있습니다.
- `dataconnect/` – Data Connect 설정과 예제 스키마(`schema/schema.gql`). 현재는 영화 리뷰 도메인 예제로 남아 있습니다.
- 루트 구성 파일 – `firebase.json`, `firestore.rules`, `firestore.index.json` 등 Firebase 프로젝트 전역 설정.

## 사전 준비물
- Node.js 22 이상
- npm
- Firebase CLI(`npm install -g firebase-tools`)
- Firebase 프로젝트에 대한 권한 및 로그인(`firebase login`)

## 설치
1. 저장소 클론 후 루트로 이동합니다.
2. Cloud Functions 의존성을 설치합니다.
   ```bash
   cd functions
   npm install
   ```
3. 필요 시 다시 루트로 돌아옵니다(`cd ..`). 정적 호스팅은 추가 빌드 과정 없이 `public/`을 그대로 사용합니다.

## 필수 설정
- **Genkit 모델 API 키**: `functions/src/genkit-sample.ts`는 `GOOGLE_GENAI_API_KEY` 시크릿을 요구합니다. Firebase CLI에서 다음과 같이 설정합니다.
  ```bash
  firebase functions:secrets:set GOOGLE_GENAI_API_KEY
  ```
  배포 시 해당 시크릿을 Cloud Functions에 연결하여 모델 호출을 수행합니다.

- **Data Connect**: `dataconnect/dataconnect.yaml`과 `schema/schema.gql`은 샘플 스키마입니다. 실제 서비스 스키마로 교체하고 Cloud SQL 인스턴스 정보를 수정한 뒤 Data Connect를 배포하세요.

## 로컬 실행
Firebase Emulator를 사용해 호스팅과 Functions를 함께 실행할 수 있습니다.
```bash
firebase emulators:start
```
- 호스팅: http://localhost:5000
- Functions: http://localhost:5001 (기본값)

Functions만 필요하면 다음을 사용할 수 있습니다.
```bash
npm --prefix functions run serve
```

## 배포
각 서비스별로 배포할 수 있습니다.
- 전체 배포:
  ```bash
  firebase deploy
  ```
- Functions만 배포:
  ```bash
  npm --prefix functions run deploy
  ```

배포 전 `firebase use <project_id>`로 올바른 프로젝트를 선택했는지 확인하세요.

## 추가 참고
- `functions/src/genkit-sample.ts`의 `menuSuggestionFlow`는 모델 이름과 플러그인 구성이 비어 있으므로 실제 모델/플러그인을 지정해야 합니다.
- `dataconnect/schema/schema.gql`는 영화 리뷰 예시이므로 실제 서비스 도메인에 맞게 스키마를 설계해야 합니다.
