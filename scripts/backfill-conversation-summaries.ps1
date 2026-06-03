# StaySee — batch backfill conversation_summary (run after deploy + migration)
# Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or BACKFILL_SECRET on edge function)

param(
  [int]$BatchSize = 8,
  [switch]$DryRun
)

$baseUrl = $env:SUPABASE_URL
if (-not $baseUrl) {
  Write-Error "Set SUPABASE_URL"
  exit 1
}

$headers = @{
  "Content-Type" = "application/json"
  "Apikey"       = $env:SUPABASE_SERVICE_ROLE_KEY
}

if ($env:SUPABASE_SERVICE_ROLE_KEY) {
  $headers["Authorization"] = "Bearer $($env:SUPABASE_SERVICE_ROLE_KEY)"
}
if ($env:BACKFILL_SECRET) {
  $headers["X-Backfill-Secret"] = $env:BACKFILL_SECRET
}

$cursor = $null
$totalOk = 0
$round = 0

do {
  $round++
  $body = @{ batchSize = $BatchSize }
  if ($cursor) { $body.cursor = $cursor }
  if ($DryRun) { $body.dryRun = $true }

  $json = $body | ConvertTo-Json
  $url = "$baseUrl/functions/v1/backfill-conversation-summaries"

  Write-Host "Round $round ..."
  $resp = Invoke-RestMethod -Method Post -Uri $url -Headers $headers -Body $json
  $totalOk += $resp.ok
  $cursor = $resp.nextCursor
  Write-Host "  ok=$($resp.ok) failed=$($resp.failed) done=$($resp.done)"
  if ($resp.hint) { Write-Host "  $($resp.hint)" }
} while (-not $resp.done)

Write-Host "Finished. Total summaries written: $totalOk"
