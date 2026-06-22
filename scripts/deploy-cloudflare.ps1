param(
  [Parameter(Mandatory = $true)]
  [string]$AccountId,
  [Parameter(Mandatory = $true)]
  [string]$ApiToken,
  [string]$ProjectName = "lilf95catch",
  [string]$Domain = "LiLcatch.shatranj.space",
  [string]$ZoneId = ""
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

  if (-not $ZoneId) {
    $ZoneId = ((Invoke-RestMethod -Headers $headers -Uri "https://api.cloudflare.com/client/v4/zones?name=shatranj.space").result | Select-Object -First 1).id
  }
  if (-not $ZoneId) { throw "Cloudflare zone shatranj.space not found" }
  $recordsUri = "https://api.cloudflare.com/client/v4/zones/$ZoneId/dns_records"
  $record = (Invoke-RestMethod -Headers $headers -Uri "$recordsUri?name=$Domain&type=CNAME").result | Select-Object -First 1
  $dnsBody = @{
    type = "CNAME"
    name = ($Domain -replace "\.shatranj\.space$", "")
    content = "$ProjectName.pages.dev"
    proxied = $true
    ttl = 1
  } | ConvertTo-Json
  if ($record) {
    Invoke-RestMethod -Method Put -Headers $headers -Uri "$recordsUri/$($record.id)" -Body $dnsBody | Out-Null
  } else {
    Invoke-RestMethod -Method Post -Headers $headers -Uri $recordsUri -Body $dnsBody | Out-Null
  }
} finally {
  Pop-Location
}

Write-Host "Cloudflare Pages deployment requested for https://$Domain"
