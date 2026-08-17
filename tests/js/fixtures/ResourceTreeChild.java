import java.net.InetAddress;
import java.net.ServerSocket;

public final class ResourceTreeChild {
    private ResourceTreeChild() {}

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);
        try (ServerSocket server = new ServerSocket(
                port, 1, InetAddress.getByName("127.0.0.1"))) {
            while (true) server.accept().close();
        }
    }
}
