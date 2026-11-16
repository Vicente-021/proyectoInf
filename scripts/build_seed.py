#!/usr/bin/env python3
"""Genera mvp/data/seed.json desde la planilla de Calbuco.

No usa dependencias externas: lee el .xlsx como ZIP + XML.
Anonimiza el cliente y el contacto; conserva solo datos operacionales.
"""
from __future__ import annotations

import json
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from pathlib import Path

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / "entrega_2" / "ENERGIA CALBUCO JUN 2026.xlsx"
OUT = ROOT / "data" / "seed.json"


def shared_strings(z: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return [
        "".join(t.text or "" for t in si.iter(NS + "t"))
        for si in root.iter(NS + "si")
    ]


def sheet_paths(z: zipfile.ZipFile) -> dict[str, str]:
    workbook = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    targets = {
        rel.get("Id"): rel.get("Target", "")
        for rel in rels.iter(PKG_REL_NS + "Relationship")
    }
    paths = {}
    for sheet in workbook.iter(NS + "sheet"):
        name = sheet.get("name")
        rid = sheet.get(REL_NS + "id")
        target = targets[rid].lstrip("/")
        if not target.startswith("xl/"):
            target = "xl/" + target
        paths[name] = target
    return paths


def read_cells(z: zipfile.ZipFile, path: str, strings: list[str]) -> dict[str, str]:
    root = ET.fromstring(z.read(path))
    cells: dict[str, str] = {}
    for cell in root.iter(NS + "c"):
        ref = cell.get("r")
        value = cell.find(NS + "v")
        if value is None or value.text is None:
            continue
        if cell.get("t") == "s":
            cells[ref] = strings[int(value.text)]
        else:
            cells[ref] = value.text
    return cells


def serial_to_date(serial: float) -> date:
    # Excel usa 1899-12-30 como origen en el sistema de fechas de 1900.
    return date(1899, 12, 30) + timedelta(days=int(serial))


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"No se encontró la planilla: {SOURCE}")

    with zipfile.ZipFile(SOURCE) as z:
        strings = shared_strings(z)
        paths = sheet_paths(z)
        daily = read_cells(z, paths["JUN KWh"], strings)
        hourly = read_cells(z, paths["EESS"], strings)

        daily_readings = []
        reference_lines = []
        for row in range(19, 49):
            serial = float(daily[f"C{row}"])
            kwh = float(daily[f"E{row}"])
            ts = serial_to_date(serial).isoformat()
            daily_readings.append({"ts": ts, "kwh": round(kwh, 9)})
            reference_lines.append(
                {
                    "ts": ts,
                    "kwh": round(kwh, 9),
                    "amount_clp": round(float(daily[f"I{row}"]), 6),
                }
            )

        hourly_readings = []
        for row in range(2, 753):
            ts = hourly[f"A{row}"].strip()
            value = float(hourly[f"B{row}"])
            hourly_readings.append({"ts": ts, "cum_kwh": value})

        reference = {
            "total_kwh": round(float(daily["E12"]), 9),
            "total_clp": round(float(daily["I12"]), 6),
            "total_liters": round(float(daily["L51"]), 6),
            "factor_l_per_kwh": round(float(daily["N51"]), 12),
            "price_usd_per_kwh": round(float(daily["F19"]), 12),
            "exchange_rate": round(float(daily["G19"]), 9),
            "price_clp_per_kwh": round(float(daily["H19"]), 12),
            "lines": reference_lines,
        }

    # Cliente A: dato real anonimizado. B y C: cartera sintética derivada de A.
    a_readings = [
        {"meter_id": "M-04", "ts": reading["ts"], "kwh": reading["kwh"]}
        for reading in daily_readings
    ]
    synthetic_specs = [
        ("M-01", 0.65, "2026-05-15"),  # falta una lectura para demostrar el ingreso manual
        ("M-02", 0.45, None),
    ]
    all_daily = list(a_readings)
    for meter_id, scale, missing_ts in synthetic_specs:
        for reading in daily_readings:
            if missing_ts and reading["ts"] == missing_ts:
                continue
            all_daily.append(
                {
                    "meter_id": meter_id,
                    "ts": reading["ts"],
                    "kwh": round(reading["kwh"] * scale, 3),
                }
            )

    all_hourly = [
        {"meter_id": "M-04", "ts": reading["ts"], "cum_kwh": reading["cum_kwh"]}
        for reading in hourly_readings
    ]

    payload = {
        "meta": {
            "source": SOURCE.name,
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "period": "2026-05",
            "invoice_month": "2026-06",
            "anonymized": True,
            "synthetic_clients": ["CLI-B", "CLI-C"],
            "notes": (
                "Lecturas diarias del período 2026-05-01 a 2026-05-30. "
                "La serie horaria (EESS) cubre 2026-05-30 17:00 a 2026-06-30 23:00. "
                "El cliente A y su contacto fueron anonimizados. "
                "Los clientes B y C son sintéticos y derivan de A para la demostración."
            ),
        },
        "clients": [
            {
                "id": "CLI-A",
                "name": "Cliente A",
                "contact": "contacto@cliente-a.cl",
                "synthetic": False,
            },
            {
                "id": "CLI-B",
                "name": "Cliente B",
                "contact": "contacto@cliente-b.cl",
                "synthetic": True,
            },
            {
                "id": "CLI-C",
                "name": "Cliente C",
                "contact": "contacto@cliente-c.cl",
                "synthetic": True,
            },
        ],
        "meters": [
            {"id": "M-04", "client_id": "CLI-A", "barge": "Barcaza 2", "source": "eGauge"},
            {"id": "M-01", "client_id": "CLI-B", "barge": "Barcaza 1", "source": "eGauge"},
            {"id": "M-02", "client_id": "CLI-C", "barge": "Barcaza 1", "source": "eGauge"},
        ],
        "contracts": [
            {
                "id": "CT-2026-014",
                "client_id": "CLI-A",
                "factor_l_per_kwh": reference["factor_l_per_kwh"],
                "price_usd_per_kwh": reference["price_usd_per_kwh"],
                "exchange_rate": reference["exchange_rate"],
                "valid_from": "2026-05-01",
                "valid_to": "2026-12-31",
            },
            {
                "id": "CT-2026-009",
                "client_id": "CLI-B",
                "factor_l_per_kwh": 1.08,
                "price_usd_per_kwh": reference["price_usd_per_kwh"],
                "exchange_rate": reference["exchange_rate"],
                "valid_from": "2026-05-01",
                "valid_to": "2026-12-31",
            },
            {
                "id": "CT-2026-010",
                "client_id": "CLI-C",
                "factor_l_per_kwh": 1.04,
                "price_usd_per_kwh": reference["price_usd_per_kwh"],
                "exchange_rate": reference["exchange_rate"],
                "valid_from": "2026-05-01",
                "valid_to": "2026-12-31",
            },
        ],
        "prices": [
            {
                "date": "2026-05-31",
                "usd_per_kwh": reference["price_usd_per_kwh"],
                "exchange_rate": reference["exchange_rate"],
                "source": "Planilla de facturación (precio de cierre)",
            }
        ],
        "daily_readings": all_daily,
        "hourly_readings": all_hourly,
        "reference": reference,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    total_a = sum(r["kwh"] for r in a_readings)
    print(f"seed: {OUT}")
    print(f"clientes: {len(payload['clients'])} | lecturas diarias: {len(all_daily)}")
    print(f"lecturas horarias: {len(all_hourly)}")
    print(f"referencia A: {total_a:.6f} kWh | {reference['total_clp']:.2f} CLP")


if __name__ == "__main__":
    main()
