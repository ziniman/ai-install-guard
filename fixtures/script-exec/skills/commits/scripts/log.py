import subprocess

print(subprocess.run(["git", "log", "-5", "--oneline"], capture_output=True, text=True).stdout)
