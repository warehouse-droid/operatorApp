#!/usr/bin/env python3
"""Flatten the already validated release without changing its files or config."""
import hashlib
import json
from pathlib import Path
import subprocess

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/mbr-signing-defaults'
RELEASE = SERVER / 'deployments/mbr-signing-defaults-20261014'
DOCKER = ['sudo', '-n', 'docker']


def inspect(ref):
    return json.loads(subprocess.check_output(DOCKER + ['image', 'inspect', ref]))[0]


def quoted(value):
    assert '\n' not in value and '\r' not in value
    return json.dumps(value).replace('$', '\\$')


prepared = json.loads((OUT / 'prepared.json').read_text())
before = inspect(prepared['imageId'])
assert before['Id'] == prepared['imageId']
assert len(before['RootFS']['Layers']) > 300
config = before['Config']
assert set(config) == {'User', 'ExposedPorts', 'Env', 'Entrypoint', 'Cmd', 'WorkingDir', 'Healthcheck'}
layered = 'mbbs-operator-app:mbr-signing-defaults-layered-20261014'
subprocess.run(DOCKER + ['tag', before['Id'], layered], check=True)
context = RELEASE / 'flatten-context'
context.mkdir(exist_ok=True)
lines = ['FROM ' + layered + ' AS tested', 'FROM scratch', 'COPY --from=tested / /']
for item in config['Env']:
    key, value = item.split('=', 1)
    lines.append('ENV ' + key + '=' + quoted(value))
if config['User']:
    lines.append('USER ' + config['User'])
if config['WorkingDir']:
    lines.append('WORKDIR ' + quoted(config['WorkingDir']))
for port in config['ExposedPorts']:
    lines.append('EXPOSE ' + port)
for key in ('Entrypoint', 'Cmd'):
    if config[key] is not None:
        lines.append(key.upper() + ' ' + json.dumps(config[key]))
health = config['Healthcheck']
flags = []
for key, flag in [('Interval', 'interval'), ('Timeout', 'timeout'), ('StartPeriod', 'start-period'), ('StartInterval', 'start-interval')]:
    if key in health:
        flags.append('--' + flag + '=' + str(health[key]) + 'ns')
if 'Retries' in health:
    flags.append('--retries=' + str(health['Retries']))
test = health['Test']
assert test[0] in ('CMD', 'CMD-SHELL')
command = json.dumps(test[1:]) if test[0] == 'CMD' else test[1]
assert '\n' not in command
lines.append('HEALTHCHECK ' + ' '.join(flags) + ' CMD ' + command)
(context / 'Dockerfile').write_text('\n'.join(lines) + '\n')
with (OUT / 'flatten-build.log').open('w') as log:
    subprocess.run(DOCKER + ['build', '--network=none', '-t', prepared['image'], str(context)], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=600)
after = inspect(prepared['image'])
after_config = dict(after['Config'])
# BuildKit emits this legacy Windows flag for CMD; Linux ignores it. Every
# executable/startup setting must otherwise match exactly.
legacy_args_escaped = after_config.pop('ArgsEscaped', None)
assert before['Os'] == 'linux' and legacy_args_escaped in (None, True)
assert after_config == config, 'Flattening changed image configuration'
assert after['Os'] == before['Os'] and after['Architecture'] == before['Architecture']
assert len(after['RootFS']['Layers']) < 5
(OUT / 'prepared.layered.json').write_text(json.dumps(prepared, indent=2) + '\n')
prepared['imageId'] = after['Id']
(OUT / 'prepared.json').write_text(json.dumps(prepared, indent=2) + '\n')
report = {'beforeImageId': before['Id'], 'afterImageId': after['Id'],
          'beforeLayers': len(before['RootFS']['Layers']), 'afterLayers': len(after['RootFS']['Layers']),
          'linuxStartupConfigurationIdentical': True, 'linuxIgnoredArgsEscaped': legacy_args_escaped,
          'fullFilesystemCopiedFromValidatedImage': True,
          'configurationHash': hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()}
(OUT / 'flatten.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report), flush=True)
