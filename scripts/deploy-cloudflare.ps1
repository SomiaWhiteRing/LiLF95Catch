param(
  [Parameter(Mandatory = $true)]
  [string]$AccountId,
  [Parameter(Mandatory = $true)]
  [string]$ApiToken,
  [string]$ProjectName = "lilf95catch",
  [string]$Domain = "LiL.shatranj.space"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$headers = @{ Authorization = "Bearer $ApiToken"; "Content-Type" = "application/json" }

Push-Location $root
try {
  npm --prefix viewer ci
  python -m crawler.lilf95_crawler.cli build-static-viewer-data --out viewer/public/datasets
  npm --prefix viewer run build

  $env:CLOUDFLARE_API_TOKEN = $ApiToken
  npx --yes wrangler@latest pages project create $ProjectName --production-branch master 2>$null
  npx --yes wrangler@latest pages deploy viewer/out --project-name=$ProjectName --branch=master --commit-dirty=true

  $body = @{ name = $Domain } | ConvertTo-Json
  try {
    Invoke-RestMethod `
      -Method Post `
      -Uri "https://api.cloudflare.com/client/v4/accounts/$AccountId/pages/projects/$ProjectName/domains" `
      -Headers $headers `
      -Body $body | Out-Null
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 409) { throw }
  }
} finally {
  Pop-Location
}

Write-Host "Cloudflare Pages deployment requested for https://$Domain"
