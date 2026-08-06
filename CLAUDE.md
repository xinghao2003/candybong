## Guiding Principles
- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Notes
- This repo is using `uv` for Python environment management. Use `uv run <script>` to run scripts in the correct environment.

## Firmware reverse engineering

The Candybong firmware lives in `firmware/twice/` (e.g.
`nordic_tw3_230206_V1_3_RF447_9_OTA`). Do all Ghidra work in `ghidra_work/`
(gitignored): extracted images, the Ghidra project, output dumps, and driver
scripts.

**Image structure**

- The `.OTA` file is a Nordic DFU ZIP. Extract it: `manifest.json` + a raw app
  `.bin` (nRF52, ARM Cortex-M4, Thumb, little-endian) + a `.dat` init packet.
- The app image is linked at base `0x26000` (SoftDevice app region). Verify
  from the vector table at offset 0: initial SP must be a RAM address
  (`0x2000b8b8`), and reset vector `0x263c1` = base + `0x3C1`.
  File offset = flash address - `0x26000`.

**Ghidra workflow (Ghidra 12 — no Jython, use PyGhidra)**

- Import: `analyzeHeadless <proj_dir> <proj> -import <bin> -loader BinaryLoader
  -loader-baseAddr 0x26000 -processor ARM:LE:32:Cortex -overwrite
  -analysisTimeoutPerFile 600`. Loader args use `-loader-<name>` syntax (NOT
  `-baseAddr`), and the project directory must already exist.
- Re-open + script with the PyGhidra venv:
  `%APPDATA%\ghidra\ghidra_12.1.2_PUBLIC\venv\Scripts\python.exe`.
  Pattern: `pyghidra.open_program(bin, project_location=..., project_name='tw3',
  program_name='<bin name>', nested_project_location=False, analyze=False)`;
  import `ghidra.*` classes INSIDE the with-block; FlatProgramAPI has no
  `.decompile()` — use `DecompInterface` + `ConsoleTaskMonitor`.
- If analysis missed a region ("NO FUNCTION AT"), force-create:
  `api.createFunction(api.toAddr(0x...), "name")`; callers of known functions
  (`getReferencesTo`) often live in those unanalyzed regions.
- Resolve RAM globals: disassemble the `ldr rX,[0x....]` literal, read the
  pointer word from the raw file at `addr - 0x26000`, then byte-search the
  image for that 4-byte pattern to find every reader/writer.
- Key addresses: BLE dispatch `ble_nus_data_handler` @ `0x35dc0`; `FF 16`
  battery → `FUN_00038958` reading 16-bit RAM `0x20002e20`, replies
  `FF 16 02 <grade> <checksum>` via `FUN_0002ed10` (NUS TX). Full inventory:
  `docs/bluetooth-command-reference.md`.

**Ghidra general tricks**

- Raw binaries: derive the load base before importing — vector table word 0
  (initial SP) is a RAM address; word 1 (reset) minus its file offset gives the
  base.
- `ldr rX,[pc,#imm]` operands are literal-pool pointers in flash — read the raw
  word from the file to resolve RAM addresses.
- Grep for nRF52 peripheral bases to find drivers: SAADC `0x40007000`, POWER
  `0x40000000`, TIMER `0x40008000`.
- SoftDevice calls appear as `software_interrupt(0x..)` SVCs — that boundary is
  where BLE behavior (notifications, advertising) happens.
- Run analysis once per import; use `-noanalysis` for later re-opens.
