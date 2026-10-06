// Command probe is a static binary run INSIDE the candidate witness sandbox
// to report what that sandbox actually allows. It prints one JSON object per
// check and never prints an environment value, only variable NAMES.
//
// Modes: (default) run all checks; -child sleeps (used by the pid-limit
// check); -mem allocates and touches memory until killed.
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

type result struct {
	Check  string `json:"check"`
	Result string `json:"result"`
}

func emit(check, res string) {
	b, _ := json.Marshal(result{check, res})
	fmt.Println(string(b))
}

func errStr(err error) string {
	if err == nil {
		return "ok"
	}
	s := err.Error()
	if len(s) > 90 {
		s = s[:90]
	}
	return "blocked: " + s
}

func writeTest(path string) string {
	f, err := os.Create(path)
	if err == nil {
		f.Close()
		os.Remove(path)
	}
	return errStr(err)
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-child" {
		time.Sleep(20 * time.Second)
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "-mem" {
		var keep [][]byte
		for i := 0; i < 64; i++ {
			b := make([]byte, 32<<20)
			for j := range b {
				b[j] = 1
			}
			keep = append(keep, b)
		}
		emit("mem_2GiB_alloc", "NOT limited: allocated 2 GiB")
		return
	}

	emit("uid", fmt.Sprintf("%d", os.Getuid()))

	secret := regexp.MustCompile(`(?i)key|token|secret|password|gemini|github|credential|auth`)
	var names []string
	for _, kv := range os.Environ() {
		name := strings.SplitN(kv, "=", 2)[0]
		if secret.MatchString(name) {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		emit("env_secret_like_names", "none")
	} else {
		emit("env_secret_like_names", "PRESENT: "+strings.Join(names, ","))
	}
	emit("env_var_count", fmt.Sprintf("%d", len(os.Environ())))

	c, err := net.DialTimeout("tcp", "1.1.1.1:443", 3*time.Second)
	if err == nil {
		c.Close()
	}
	emit("net_tcp_1.1.1.1:443", errStr(err))
	_, err = net.LookupHost("example.com")
	emit("net_dns_example.com", errStr(err))

	emit("write_/", writeTest("/probe_write"))
	emit("write_/tmp", writeTest("/tmp/probe_write"))
	emit("write_/work", writeTest("/work/probe_write"))

	// Workspace credential check: report only whether credential-looking
	// strings exist, never the strings.
	cred := regexp.MustCompile(`(?i)extraheader|authorization|x-access-token|ghp_|ghs_|github_pat_`)
	data, err := os.ReadFile("/work/.git/config")
	switch {
	case err != nil:
		emit("workspace_git_config", "unreadable or absent: "+errStr(err))
	case cred.Match(data):
		emit("workspace_git_config", "READABLE and contains credential-like text")
	default:
		emit("workspace_git_config", "readable, no credential-like text")
	}

	started := 0
	var procs []*exec.Cmd
	for i := 0; i < 200; i++ {
		cmd := exec.Command("/probe", "-child")
		if err := cmd.Start(); err != nil {
			break
		}
		procs = append(procs, cmd)
		started++
	}
	for _, p := range procs {
		p.Process.Kill()
	}
	emit("pid_limit_children_started_of_200", fmt.Sprintf("%d", started))
}
