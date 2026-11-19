package transport

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/quic-go/quic-go/http3"
	wt "github.com/quic-go/webtransport-go"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"os"
	"testing"
	"time"
)

func ports(t *testing.T) (*Port, *Port) {
	t.Helper()
	a := netip.MustParseAddrPort("192.0.2.1:4040")
	b := netip.MustParseAddrPort("192.0.2.2:443")
	x, _ := NewPort(a, b)
	y, _ := NewPort(b, a)
	forward := func(from, to *Port) {
		for {
			select {
			case <-from.done:
				return
			case <-to.done:
				return
			case p := <-from.out:
				if e := to.Feed(from.local, p); e != nil && !errors.Is(e, net.ErrClosed) {
					return
				}
			}
		}
	}
	go forward(x, y)
	go forward(y, x)
	t.Cleanup(func() { x.Close(); y.Close() })
	return x, y
}
func certificate(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	k, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	c := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "wt.test"}, DNSNames: []string{"wt.test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	der, e := x509.CreateCertificate(rand.Reader, c, c, &k.PublicKey, k)
	if e != nil {
		t.Fatal(e)
	}
	leaf, e := x509.ParseCertificate(der)
	if e != nil {
		t.Fatal(e)
	}
	roots := x509.NewCertPool()
	roots.AddCert(leaf)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: k, Leaf: leaf}, roots
}
func TestWebTransport(t *testing.T) {
	for _, trusted := range []bool{true, false} {
		t.Run(map[bool]string{true: "stream_and_datagram", false: "unknown_ca"}[trusted], func(t *testing.T) {
			a, b := ports(t)
			cert, roots := certificate(t)
			ctx, stop := context.WithTimeout(context.Background(), HandshakeTimeout)
			defer stop()
			srv := wt.Server{H3: &http3.Server{TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, NextProtos: []string{"h3"}, MinVersion: tls.VersionTLS13}}}
			srv.H3.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Origin") != "https://wt.test" || r.URL.Path != "/echo" {
					http.Error(w, "origin or path", 403)
					return
				}
				s, e := srv.Upgrade(w, r)
				if e != nil {
					return
				}
				go func() {
					st, e := s.AcceptStream(ctx)
					if e != nil {
						return
					}
					msg, e := io.ReadAll(io.LimitReader(st, 512))
					if e != nil {
						return
					}
					st.Write(msg)
					st.Close()
				}()
				go func() {
					v, e := s.ReceiveDatagram(ctx)
					if e == nil {
						s.SendDatagram(v)
					}
				}()
			})
			go srv.Serve(b)
			defer srv.Close()
			if !trusted {
				roots = x509.NewCertPool()
			}
			s, e := DialWebTransport(ctx, a, b.LocalAddr().(*net.UDPAddr), "https://wt.test/echo", "https://wt.test", roots, nil)
			if !trusted {
				if e == nil {
					t.Fatal("unexpectedly accepted unknown CA")
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			defer s.CloseWithError(0, "done")
			st, e := s.OpenStreamSync(ctx)
			if e != nil {
				t.Fatal(e)
			}
			st.SetDeadline(time.Now().Add(5 * time.Second))
			if _, e = st.Write([]byte("stream")); e != nil {
				t.Fatal(e)
			}
			st.Close()
			got, e := io.ReadAll(st)
			if e != nil || string(got) != "stream" {
				t.Fatalf("stream: %q %v", got, e)
			}
			if e = s.SendDatagram([]byte("datagram")); e != nil {
				t.Fatal(e)
			}
			got, e = s.ReceiveDatagram(ctx)
			if e != nil || string(got) != "datagram" {
				t.Fatalf("datagram: %q %v", got, e)
			}
		})
	}
}
func TestRTCDataAndMedia(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), HandshakeTimeout)
	defer cancel()
	a, b := ports(t)
	alice, e := NewPeer(a)
	if e != nil {
		t.Fatal(e)
	}
	defer alice.Close()
	bob, e := NewPeer(b)
	if e != nil {
		t.Fatal(e)
	}
	defer bob.Close()
	recv := make(chan string, 1)
	media := make(chan []byte, 1)
	bob.OnDataChannel(func(d *webrtc.DataChannel) {
		d.OnMessage(func(m webrtc.DataChannelMessage) {
			select {
			case recv <- string(m.Data):
			default:
			}
		})
	})
	bob.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		p, _, e := tr.ReadRTP()
		if e == nil {
			select {
			case media <- p.Payload:
			default:
			}
		}
	})
	track, e := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "sound", "session")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = alice.AddTrack(track); e != nil {
		t.Fatal(e)
	}
	d, e := alice.CreateDataChannel("test", nil)
	if e != nil {
		t.Fatal(e)
	}
	d.OnOpen(func() { d.SendText("encrypted data channel") })
	offer, e := alice.Gather(ctx, true)
	if e != nil {
		t.Fatal(e)
	}
	if e = bob.SetRemoteDescription(offer); e != nil {
		t.Fatal(e)
	}
	answer, e := bob.Gather(ctx, false)
	if e != nil {
		t.Fatal(e)
	}
	if e = alice.SetRemoteDescription(answer); e != nil {
		t.Fatal(e)
	}
	select {
	case v := <-recv:
		if v != "encrypted data channel" {
			t.Fatal(v)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err(), alice.ConnectionState(), bob.ConnectionState())
	}
	for i := uint16(0); i < 8; i++ {
		if e = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: i, Timestamp: uint32(i) * 960}, Payload: []byte{0xf8, 0xff, 0xfe}}); e != nil {
			t.Fatal(e)
		}
	}
	select {
	case p := <-media:
		if len(p) != 3 || p[0] != 0xf8 {
			t.Fatal("bad RTP payload")
		}
	case <-ctx.Done():
		t.Fatal("no authenticated media", ctx.Err())
	}
}
func TestPortBoundaries(t *testing.T) {
	a := netip.MustParseAddrPort("192.0.2.10:77")
	b := netip.MustParseAddrPort("192.0.2.11:88")
	p, _ := NewPort(a, b)
	defer p.Close()
	if !errors.Is(p.Feed(a, []byte{1}), ErrPeer) || !errors.Is(p.Feed(b, make([]byte, MaxDatagram+1)), ErrSize) {
		t.Fatal("input policy")
	}
	for range QueueDepth {
		if e := p.Feed(b, []byte{1}); e != nil {
			t.Fatal(e)
		}
	}
	if !errors.Is(p.Feed(b, []byte{2}), ErrFull) {
		t.Fatal("queue not bounded")
	}
	if _, e := p.WriteTo([]byte{1}, net.UDPAddrFromAddrPort(a)); !errors.Is(e, ErrPeer) {
		t.Fatal(e)
	}
	q, _ := NewPort(a, b)
	defer q.Close()
	q.SetReadDeadline(time.Now().Add(time.Millisecond))
	if _, _, e := q.ReadFrom(make([]byte, 4)); !errors.Is(e, os.ErrDeadlineExceeded) {
		t.Fatal(e)
	}
	p.Close()
	if e := p.Feed(b, []byte{1}); !errors.Is(e, net.ErrClosed) {
		t.Fatal(e)
	}
}
