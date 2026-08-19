# Homebrew formula for ReClaude. Lives in a tap:
#   brew tap natpalmer-e4o4/tools
#   brew install reclaude
#   brew services start reclaude    # keeps the file-history mirror running
class Reclaude < Formula
  desc "Flight recorder for the Claude Code context window"
  homepage "https://github.com/natpalmer-e4o4/ReClaude"
  url "https://github.com/natpalmer-e4o4/ReClaude/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_TARBALL_SHA256"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"reclaude").write_env_script libexec/"bin/cli.js", PATH: "#{Formula["node"].opt_bin}:$PATH"
    chmod 0755, bin/"reclaude"
  end

  service do
    run [opt_bin/"reclaude", "--no-open"]
    keep_alive true
    run_type :immediate
    log_path var/"log/reclaude.log"
    error_log_path var/"log/reclaude.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/reclaude --version")
  end
end
