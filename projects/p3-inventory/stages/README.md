# Checkpoint-3 snapshot of the reference

`cp3.patch` turns a copy of `reference/` (the final, checkpoint-5 code) back into the reference as it was at the end
of checkpoint 3 (schema v3: stock on the product, no warehouses or variants). It exists only to prove the CP4
migration on a real CP3 database (`hazards/prove.sh`, `tools/selftest.sh`):

    cp -R reference /some/dir/cp3 && (cd /some/dir/cp3 && patch -p1 -E -s < <project>/stages/cp3.patch)

It is stored as a patch, not as a tree, so no hidden file is byte-identical to a scaffold file (the harness's leak scan).
