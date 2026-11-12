# Hóng Sub voice helper: reads JSON lines on stdin, answers JSON lines on stdout.
#   {"id":1,"cmd":"voices"}                                   -> {"id":1,"voices":[{name,lang,gender}]}
#   {"id":2,"cmd":"speak","text":"<base64 utf8>","voice":"Microsoft An","rate":1.1}  -> {"id":2,"wav":"<base64>"}
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(-1)
  $task.Result
}
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
function Send($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush() }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $m = $null
  try {
    $m = $line | ConvertFrom-Json
    $all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
    if ($m.cmd -eq 'voices') {
      $list = @($all | ForEach-Object { @{ name = $_.DisplayName; lang = $_.Language; gender = "$($_.Gender)" } })
      Send @{ id = $m.id; voices = $list }
    } elseif ($m.cmd -eq 'speak') {
      $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($m.text))
      $voice = $null
      if ($m.voice) { $voice = $all | Where-Object { $_.DisplayName -eq $m.voice } | Select-Object -First 1 }
      if (-not $voice) { $voice = $all | Where-Object { $_.Language -like 'vi*' } | Select-Object -First 1 }
      if (-not $voice -and $m.any) { $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::DefaultVoice }
      if (-not $voice) { Send @{ id = $m.id; err = 'novoice' }; continue }
      $synth.Voice = $voice
      try { $synth.Options.SpeakingRate = [double]$m.rate } catch { }
      $stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
      $size = [uint32]$stream.Size
      $reader = New-Object Windows.Storage.Streams.DataReader ($stream.GetInputStreamAt(0))
      $null = Await ($reader.LoadAsync($size)) ([uint32])
      $bytes = New-Object byte[] $size
      $reader.ReadBytes($bytes)
      $reader.Dispose(); $stream.Dispose()
      Send @{ id = $m.id; wav = [Convert]::ToBase64String($bytes) }
    }
  } catch {
    $id = $null; if ($m) { $id = $m.id }
    Send @{ id = $id; err = "$($_.Exception.Message)" }
  }
}
