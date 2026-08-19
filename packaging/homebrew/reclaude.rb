# Homebrew formula for ReClaude. Lives in a tap:
#   brew tap natpalmer-e4o4/tools
#   brew install reclaude
#   brew services start reclaude    # keeps the file-history mirror running
class Reclaude < Formula
  desc "Flight recorder for the Claude Code context window"
  homepage "https://github.com/natpalmer-e4o4/ReClaude"
  url "https://github.com/natpalmer-e4o4/ReClaude/archive/refs/tags/v0.1.1.tar.gz"
  sha256 "6bfecf18bb58e72b653f5f8c2e766a72b2d4fe393461d7c471401e6feab70154"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"reclaude").write_env_script libexec/"bin/cli.js", PATH: "#{formula_opt_bin("node")}:$PATH"
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
