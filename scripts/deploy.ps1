# Deploy what is checked out to the live AWS site: the API (Lambda, via SAM) and the website (S3).
# Nothing deploys on its own when main changes: run this after merging.
#
#   git checkout main; git pull
#   powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1            # API + website
#   powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -WebOnly   # website only (frontend changes)
#   powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -ApiOnly   # API only (nikaas/ or template.yaml changes)
#
# Needs: AWS CLI with credentials for the account, SAM CLI, Node + npm, and Python 3.11 (the Lambda runtime).
param([switch]$WebOnly, [switch]$ApiOnly)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root
$region = 'ap-south-1'
$stack = 'nikaas'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Run($exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe $($argv -join ' ') failed ($LASTEXITCODE)" }
}

Step 'What is being deployed'
$head = git log -1 --format='%h %an: %s'
Write-Host $head
if (git status --porcelain --untracked-files=no) { Write-Warning 'There are uncommitted changes: they will be deployed too.' }
git fetch -q origin main 2>$null
$behind = git rev-list --count HEAD..origin/main 2>$null
if ($behind -and [int]$behind -gt 0) { Write-Warning "This checkout is $behind commit(s) behind origin/main. Run 'git pull' first to deploy the latest." }

if (-not $WebOnly) {
  Step 'API: package and deploy (SAM)'
  Run python @('scripts/build_lambda.py')
  # sam build needs the Lambda's Python (3.11) on PATH, but only for this step
  $oldPath = $env:PATH
  try {
    $py311 = (& py -3.11 -c 'import sys, os; print(os.path.dirname(sys.executable))' 2>$null)
    if ($LASTEXITCODE -eq 0 -and $py311) { $env:PATH = "$py311;$py311\Scripts;$env:PATH" }
    else { Write-Warning 'Python 3.11 not found (py -3.11): sam build may fail. Install Python 3.11 or use "sam build --use-container".' }
    $build = Join-Path $env:TEMP 'nks' # short path: Windows path-length limits break deep build folders
    if (Test-Path $build) { Remove-Item -Recurse -Force $build }
    Run sam @('build', '--build-dir', $build)
  } finally { $env:PATH = $oldPath }
  Run sam @('deploy', '--template-file', (Join-Path $build 'template.yaml'), '--config-file', (Join-Path $root 'samconfig.toml'), '--no-fail-on-empty-changeset')
}

if (-not $ApiOnly) {
  Step 'Website: build'
  Push-Location web
  try {
    if (-not (Test-Path node_modules)) { Run npm @('ci') }
    Run npm @('run', 'build')
  } finally { Pop-Location }

  Step 'Website: upload to S3'
  $bucket = aws cloudformation describe-stacks --stack-name $stack --region $region --query "Stacks[0].Outputs[?OutputKey=='WebBucketName'].OutputValue" --output text
  if (-not $bucket -or $bucket -eq 'None') { throw 'Could not read the website bucket from the stack outputs.' }
  $b = "s3://$bucket"
  # hashed assets first (cached), then the files that must never be cached, so no page points at a missing file.
  # No --delete: tabs still open on the previous build keep finding its files (they are small and never change).
  Run aws @('s3', 'sync', 'web/dist', $b, '--exclude', 'index.html', '--exclude', 'sw.js', '--exclude', 'manifest.webmanifest', '--cache-control', 'public,max-age=300', '--region', $region, '--only-show-errors')
  Run aws @('s3', 'cp', 'web/dist/fonts', "$b/fonts", '--recursive', '--content-type', 'font/woff2', '--cache-control', 'public,max-age=300', '--region', $region, '--only-show-errors')
  Run aws @('s3', 'cp', 'web/dist/sw.js', "$b/sw.js", '--cache-control', 'no-cache', '--content-type', 'text/javascript', '--region', $region, '--only-show-errors')
  Run aws @('s3', 'cp', 'web/dist/manifest.webmanifest', "$b/manifest.webmanifest", '--cache-control', 'no-cache', '--content-type', 'application/manifest+json', '--region', $region, '--only-show-errors')
  Run aws @('s3', 'cp', 'web/dist/index.html', "$b/index.html", '--cache-control', 'no-cache', '--content-type', 'text/html', '--region', $region, '--only-show-errors')
}

$url = aws cloudformation describe-stacks --stack-name $stack --region $region --query "Stacks[0].Outputs[?OutputKey=='WebHttpsUrl'].OutputValue" --output text
Step "Done: $head"
Write-Host "Live: $url  (reload the page; an installed app updates on its next open)" -ForegroundColor Green
