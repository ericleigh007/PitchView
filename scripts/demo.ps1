$ErrorActionPreference = "Stop"

Write-Host "[PitchView] Running scripted demo verification"
npm --workspace app/frontend run test -- --run src/demo.test.ts

Write-Host "[PitchView] Demo verification complete"
