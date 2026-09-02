{
  description = "carbon_frappe — a Carbon Design System theme for Frappe";

  inputs = {
    frappe-nix.url = "github:Avunu/frappe-nix";
    # flake-parts resolves perSystem `pkgs` from an input literally named `nixpkgs`.
    nixpkgs.follows = "frappe-nix/nixpkgs";

    # The framework, pinned by this repo's flake.lock. `flake = false`: it is a
    # source tree, not a flake. `nix flake update frappe` moves it — follow that
    # with `nix run .#relock`.
    frappe = {
      url = "github:frappe/frappe/version-16";
      flake = false;
    };
  };

  nixConfig = {
    extra-substituters = [ "https://devenv.cachix.org" ];
    extra-trusted-public-keys = [
      "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw="
    ];
  };

  # Outputs:
  #   devShells.<system>.default — devenv: MariaDB, Redis, web, worker, socketio…
  #   packages.<system>.default  — a built bench with this app's assets compiled in
  #   apps.<system>.relock       — regenerate nix/uv.lock + nix/node-offline-hashes.json
  outputs =
    { frappe-nix, ... }@inputs:
    frappe-nix.lib.mkFlake { inherit inputs; } (
      { ... }:
      {
        imports = [ frappe-nix.flakeModules.default ];

        systems = [
          "aarch64-darwin"
          "aarch64-linux"
          "x86_64-darwin"
          "x86_64-linux"
        ];

        perSystem = _: {
          frappe-nix = {
            enable = true;
            siteName = "carbon.localhost";

            app = {
              enable = true;
              frappeVersion = "version-16";
              frappe = inputs.frappe;
              # src defaults to `self`, name to [project].name ("carbon_frappe"),
              # benchName to "carbon-frappe", python/nodejs to the version-16
              # preset, and lockDir to ./nix.
            };
          };
        };
      }
    );
}
