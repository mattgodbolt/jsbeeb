"""Prints, as JSON, the labels py8dis's acorn.py gives a BBC Micro disassembly: what its bbc() sets up.

    python3 tools/symbols/acorn-labels.py <acorn.py>

acorn.py is run as it is, with py8dis's other modules stubbed out and its labelling commands recorded.
A label it defines as an offset from another (the vectors' "wrchv+1") is not a name, so it is left out.
"""

import builtins
import enum
import json
import sys
import types


class Stub:
    def __getattr__(self, name):
        return Stub()

    def __call__(self, *args, **kwargs):
        return Stub()


class MachineType(enum.Enum):
    MACHINE_BBC = 1
    MACHINE_BPLUS = 2
    MACHINE_MASTER = 3
    MACHINE_ELECTRON = 4
    MACHINE_6502SP = 5


def stub_module(name, **attributes):
    module = types.ModuleType(name)
    module.__all__ = []
    module.__getattr__ = lambda attribute: Stub()
    for key, value in attributes.items():
        setattr(module, key, value)
    sys.modules[name] = module


for name in ["commands", "classification", "config", "trace", "utils", "memorymanager", "maker", "snippets6502"]:
    stub_module(name)
stub_module("machinetype", MachineType=MachineType)

labels = []


def optional_label(address, name, *offset_from, **options):
    if not offset_from:
        labels.append([int(address), name])


def subroutine(address, name, *args, **options):
    labels.append([int(address), name])


class Scope(dict):
    """acorn.py's globals: what `from commands import *` would have given it are stubs."""

    def __missing__(self, key):
        if hasattr(builtins, key):
            raise KeyError(key)
        return Stub()


scope = Scope(optional_label=optional_label, subroutine=subroutine, label=subroutine, __name__="acorn")
with open(sys.argv[1]) as source:
    exec(compile(source.read(), sys.argv[1], "exec"), scope)
scope["bbc"]()
json.dump(labels, sys.stdout)
