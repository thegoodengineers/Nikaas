"""Monte Carlo check: reproducible for fixed seeds, and with no randomness it is just the nominal run."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("monte_carlo", ROOT / "scripts/monte_carlo.py")
mc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mc)
MUSEUM = str(ROOT / "data/iit_kgp_museum.json")


def test_same_seeds_same_numbers():
    assert mc.run(MUSEUM, 2) == mc.run(MUSEUM, 2)


def test_without_randomness_it_is_the_nominal_run():
    # no pre-movement spread and no occupancy spread: both plans give the nominal times (runs/wow.csv: 145.25 / 124.0)
    (_, people, near, nik), = mc.run(MUSEUM, 1, premove_max=0.0, occ=0.0)
    assert people == 507 and near == 145.25 and nik == 124.0
