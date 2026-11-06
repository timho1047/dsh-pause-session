# Releasing

This repository publishes one npm package, `dsh-pause-session`, from a Git tag.

## First npm seed

A brand-new npm package cannot use trusted publishing until it exists. Seed any
version once manually; it does not need to be the first release version. This
repository was seeded with the placeholder `0.0.0-stage`, which only reserves
the package name and is not the release.

```sh
npm publish --access public
```

Then configure a Trusted Publisher. The npm CLI can do it:

```sh
npm trust github dsh-pause-session \
  --file release.yml \
  --repo timho1047/dsh-pause-session \
  --allow-publish \
  --yes
```

The same relationship can be added in the package's settings on npmjs.com:

- Owner: `timho1047`
- Repository: `dsh-pause-session`
- Workflow: `release.yml`
- Permission: Publish

After that, tag pushes publish through GitHub Actions OIDC and do not need a
long-lived `NPM_TOKEN`. A newly created Trusted Publisher configuration must
complete its first publish within 48 hours; otherwise npm reports the exchange
as `404` and the configuration must be deleted and created again. Create or
recreate it immediately before the release tag. Check the result with:

```sh
npm trust list dsh-pause-session
```

## Normal release

1. Run `pnpm run verify`.
2. Bump `version` in `package.json`.
3. Add a matching section to `CHANGELOG.md`.
4. Run `pnpm run build` and commit the rebuilt `lib/` tree with the source.
5. Commit, tag, and push:

```sh
git tag vX.Y.Z
git push origin main --follow-tags
```

The `release` workflow validates the tag and committed bundles, packs the
package, publishes only when that exact version is absent, and creates or
updates the GitHub Release with the matching changelog section.

## Notes

- `lib/` is committed because the release runner does not install the local
  DeepSeek Harness checkout required by the source devDependencies.
- The workflow skips npm publishing when the version is already present, which
  is what allows the first manual seed and a later tag to share one version.
- If trusted publishing is temporarily unavailable, publish the generated
  tarball manually with `npm publish`, then rerun the tag workflow to create the
  GitHub Release.
- The `0.0.0-stage` placeholder can be unpublished after the first real release;
  it exists only so the package can be configured for trusted publishing.
