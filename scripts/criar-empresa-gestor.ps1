param(
  [string]$ApiUrl = 'http://localhost:3000/api/v1',
  [Parameter(Mandatory = $true)][string]$CodigoAcesso,
  [Parameter(Mandatory = $true)][string]$RazaoSocial,
  [Parameter(Mandatory = $true)][string]$NomeFantasia,
  [Parameter(Mandatory = $true)][string]$GestorNome,
  [Parameter(Mandatory = $true)][string]$GestorEmail,
  [string]$Cnpj = '',
  [string]$Telefone = ''
)

$envPath = Join-Path $PSScriptRoot '..\.env'
$secretText = $env:PROVISIONING_SECRET
if (-not $secretText -and (Test-Path -LiteralPath $envPath)) {
  $secretLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -like 'PROVISIONING_SECRET=*' } | Select-Object -First 1
  if ($secretLine) { $secretText = $secretLine.Substring('PROVISIONING_SECRET='.Length) }
}
if (-not $secretText -or $secretText.Length -lt 32) {
  throw 'PROVISIONING_SECRET ausente. Execute npm run env:configure e reinicie a API.'
}
try {
  $body = @{
    empresa = @{
      codigoAcesso = $CodigoAcesso
      razaoSocial = $RazaoSocial
      nomeFantasia = $NomeFantasia
      cnpj = $Cnpj
      telefone = $Telefone
    }
    gestor = @{
      nome = $GestorNome
      email = $GestorEmail
      telefone = $Telefone
    }
  } | ConvertTo-Json -Depth 4

  $response = Invoke-RestMethod `
    -Method Post `
    -Uri "$ApiUrl/provisionamento/empresas" `
    -Headers @{ 'X-Provisioning-Secret' = $secretText } `
    -ContentType 'application/json; charset=utf-8' `
    -Body $body

  $response.data | Format-List
} finally {
  $secretText = $null
}
